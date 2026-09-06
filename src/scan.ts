/**
 * 注入物扫描：指令链（AGENTS.md/CLAUDE.md）、技能目录、工具 schema / MCP。
 * 全部只读；文件有大小上限，路径有 skip 规则。
 */
import { dirname, join } from 'node:path'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { SkillRegistry } from '@deepseek-ai/dsh-skill'
import type { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { estimateTokens } from './tokens.ts'
import { findDuplicateBlocks, groupMcpTools, type DuplicateBlock, type McpSummary } from './analyze.ts'

/** 单文件审计上限：超过则跳过（防止审计器自身被大文件拖垮）。 */
export const MAX_FILE_BYTES = 256 * 1024

/** 指令链文件名（DSH 注入的 workspace instruction 文件）。 */
const INSTRUCTION_NAMES = ['AGENTS.md', 'CLAUDE.md']

/** 指令链审计结果。 */
export interface InstructionChainResult {
  /** git 根（含 .git 的最上层目录），找不到时回到起点目录。 */
  root: string
  /** 链上每一层的文件。 */
  files: { path: string; bytes: number; tokens: number }[]
  totalTokens: number
  duplicateBlocks: DuplicateBlock[]
}

async function pathExists(fs: FileSystem, path: string, signal: AbortSignal): Promise<boolean> {
  try {
    const target = await fs.resolve(path, { signal })
    return (await fs.stat(target, signal)) !== undefined
  } catch {
    return false
  }
}

/**
 * 从 cwd 向上找到 git 根（含 .git 的最高目录）；从根到 cwd 的每一层收集
 * AGENTS.md / CLAUDE.md，与 DSH 的 workspace instruction 注入链对齐。
 */
export async function scanInstructionChain(
  fs: FileSystem,
  cwd: string,
  signal: AbortSignal,
): Promise<InstructionChainResult> {
  // 1. 找 git 根
  let root = cwd
  let current = cwd
  for (;;) {
    if (await pathExists(fs, join(current, '.git'), signal)) {
      root = current
      break
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }

  // 2. 从 cwd 向上收集到 root 的层级，再反转成外层 → 内层
  const layers: string[] = []
  current = cwd
  for (;;) {
    layers.push(current)
    if (current === root) break
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  layers.reverse()

  // 3. 逐层读指令文件
  //
  // 去重是必须的，否则报告会和模型实际看到的对不上（issue #8）。宿主的注入链
  // 本身就去重：同一个文件命中两次只注入一份，`AGENTS.md` 与 `CLAUDE.md` 内容
  // 相同时也只注入一份。这里对齐两条：
  //   - 真实路径去重：`fs.resolve` 跟随符号链接，`CLAUDE.md -> AGENTS.md`
  //     这种布局（deepseek-harness 仓库根目录就是）会把同一个物理文件算两次，
  //     token 翻倍，还产生「自己和自己重复」的假重复块；
  //   - 内容去重：两个各自独立、内容逐字节相同的文件同理只算一份。
  const rawFiles: { path: string; bytes: number; tokens: number; content: string }[] = []
  const seenPaths = new Set<string>()
  for (const dir of layers) {
    for (const name of INSTRUCTION_NAMES) {
      const fullPath = join(dir, name)
      let target
      try {
        target = await fs.resolve(fullPath, { signal })
      } catch {
        continue // 不存在 / 不可解析
      }
      // 符号链接在 resolve 后归一到同一真实路径，据此判重。
      const realPath = fs.processPath(target)
      if (seenPaths.has(realPath)) continue
      let info
      try {
        info = await fs.stat(target, signal)
      } catch {
        continue
      }
      if (info === undefined || info.type !== 'file') continue
      if (info.size !== undefined && info.size > MAX_FILE_BYTES) continue
      let text: string
      try {
        text = await fs.readText(target, signal)
      } catch {
        continue
      }
      // 内容逐字节相同的另一个文件：宿主同样只注入一份。
      if (rawFiles.some((file) => file.content === text)) {
        seenPaths.add(realPath)
        continue
      }
      seenPaths.add(realPath)
      rawFiles.push({
        path: realPath,
        bytes: info.size ?? Buffer.byteLength(text),
        tokens: estimateTokens(text),
        content: text,
      })
    }
  }

  const totalTokens = rawFiles.reduce((acc, f) => acc + f.tokens, 0)
  const duplicateBlocks = findDuplicateBlocks(rawFiles.map((f) => ({ path: f.path, content: f.content })))
  return {
    root,
    files: rawFiles.map(({ content: _content, ...rest }) => rest),
    totalTokens,
    duplicateBlocks,
  }
}

/** 技能目录摘要（模型每个请求都会看到 catalog：name + description）。 */
export interface SkillCatalogResult {
  count: number
  totalDescriptionTokens: number
  bySource: { source: string; count: number; descriptionTokens: number }[]
  duplicateDescriptions: { name: string; description: string; count: number }[]
}

export async function scanSkillCatalog(
  skillList: Awaited<ReturnType<SkillRegistry['list']>>,
  signal: AbortSignal,
): Promise<SkillCatalogResult> {
  void signal
  const bySource = new Map<string, { count: number; descriptionTokens: number }>()
  let total = 0
  for (const skill of skillList) {
    const tokens = estimateTokens(skill.description)
    total += tokens
    const cur = bySource.get(skill.source) ?? { count: 0, descriptionTokens: 0 }
    cur.count++
    cur.descriptionTokens += tokens
    bySource.set(skill.source, cur)
  }
  return {
    count: skillList.length,
    totalDescriptionTokens: total,
    bySource: [...bySource.entries()]
      .map(([source, v]) => ({ source, ...v }))
      .sort((a, b) => b.descriptionTokens - a.descriptionTokens),
    duplicateDescriptions: skillList.map((s) => ({ name: s.name, description: s.description }))
      .filter((s) => s.description !== '')
      .reduce<{ name: string; description: string; count: number }[]>((acc, s) => {
        const key = s.description.trim().toLowerCase().replace(/\s+/g, ' ')
        const hit = acc.find((h) => h.description.trim().toLowerCase().replace(/\s+/g, ' ') === key)
        if (hit !== undefined) hit.count++
        else acc.push({ ...s, count: 1 })
        return acc
      }, [])
      .filter((h) => h.count >= 2)
      .sort((a, b) => b.count - a.count),
  }
}

/** 工具 schema（模型每请求都会看到的固定成本）。 */
export interface ToolSchemaResult {
  visibleCount: number
  schemaTokens: number
  nativeCount: number
  nativeTokens: number
  mcp: McpSummary
  /** 当前 agent 可见的 schema 明细；仅开发者回执使用。 */
  items: { name: string; bytes: number; tokens: number; schemaHash: string; server?: string }[]
  /** 以忽略 MCP 名称的签名分组，用于暴露跨 server 的重复接口。 */
  mcpDuplicates: Map<string, { name: string; server: string; bytes: number }[]>
}

export async function scanToolSchemas(
  tools: ToolRuntime,
  agent: unknown,
  signal: AbortSignal,
): Promise<ToolSchemaResult> {
  void signal
  let schemas: { name: string; description?: string; parameters?: unknown }[] = []
  try {
    schemas = tools.schemas(agent as never)
  } catch {
    try {
      schemas = tools.schemas()
    } catch {
      schemas = []
    }
  }
  let schemaTokens = 0
  let nativeCount = 0
  let nativeTokens = 0
  const items: ToolSchemaResult['items'] = []
  const mcpDuplicates = new Map<string, { name: string; server: string; bytes: number }[]>()
  for (const schema of schemas) {
    const serialised = stableJson(schema)
    const bytes = new TextEncoder().encode(serialised).byteLength
    const tokens = estimateTokens(schema.name) + estimateTokens(schema.description ?? '')
    const server = schema.name.startsWith('mcp__') ? schema.name.split('__')[1] ?? 'unknown' : undefined
    const schemaHash = hashSchema(schema.name.startsWith('mcp__')
      ? stableJson({ description: schema.description ?? '', parameters: schema.parameters ?? null })
      : serialised)
    items.push({ name: schema.name, bytes, tokens, schemaHash, ...(server !== undefined ? { server } : {}) })
    if (server !== undefined) {
      const duplicate = mcpDuplicates.get(schemaHash) ?? []
      duplicate.push({ name: schema.name, server, bytes })
      mcpDuplicates.set(schemaHash, duplicate)
    }
    schemaTokens += tokens
    if (schema.name.startsWith('mcp__')) continue
    nativeCount++
    nativeTokens += tokens
  }
  const mcp = groupMcpTools(schemas)
  return { visibleCount: schemas.length, schemaTokens, nativeCount, nativeTokens, mcp, items, mcpDuplicates }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function hashSchema(value: string): string {
  let hash = 2166136261
  for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619)
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, '0')}`
}
