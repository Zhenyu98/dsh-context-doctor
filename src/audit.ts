/**
 * 审计引擎：context_audit 工具与 HTTP 路由共用的核心逻辑。
 */
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { SkillRegistry } from '@deepseek-ai/dsh-skill'
import type { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { createHash } from 'node:crypto'
import { findDuplicateDescriptions, findRankShadows } from './analyze.ts'
import { scanInstructionChain, scanSkillCatalog, scanToolSchemas } from './scan.ts'
import { estimateTokens, formatBytes, formatTokens } from './tokens.ts'

/** 审计报告（canonical JSON 值）。 */
export interface AuditReport {
  tool: 'context_audit'
  version: 1
  cwd: string
  injected: {
    instructions: {
      root: string
      files: { path: string; bytes: number; tokens: number }[]
      totalTokens: number
      duplicateBlocks: { tokens: number; paths: string[] }[]
    }
    skills: {
      catalogCount: number
      catalogDescriptionTokens: number
      bySource: { source: string; count: number; descriptionTokens: number }[]
      duplicateDescriptions: { name: string; description: string; count: number }[]
      bodies?: { count: number; totalTokens: number }
    }
    tools: {
      visibleCount: number
      schemaTokens: number
      nativeCount: number
      nativeTokens: number
      mcp: {
        servers: { server: string; tools: number; schemaTokens: number }[]
        totalTools: number
        totalTokens: number
      }
    }
  }
  conflicts: { name: string; winner: { source: string; provider: string }; shadowed: { source: string; provider: string }[] }[]
  suggestions: { severity: 'high' | 'medium' | 'low'; text: string }[]
  /** 仅 `detail=developer` 时附加：供 Agent 定点修复的上下文审计回执。 */
  receipt?: ContextAuditReceipt
}

/** 开发者明细回执；所有条目均来自当前可观测的注入面。 */
export interface ContextAuditReceipt {
  kind: 'context-audit-receipt'
  version: 1
  detail: 'developer'
  agentsFiles: {
    path: string
    bytes: number
    tokens: number
    loadOrder: number
    duplicateBlocks: { sha256: string; tokens: number; paths: string[]; preview: string }[]
  }[]
  skills: {
    name: string
    source: string
    provider: string
    descriptionBytes: number
    descriptionTokens: number
    /** 条目在模型每请求可见的 skills catalog 中；不表示技能正文已按需读取。 */
    catalogInjected: true
  }[]
  toolSchemas: {
    totalBytes: number
    items: { name: string; bytes: number; tokens: number; schemaHash: string; server?: string }[]
  }
  duplicateMcpEntries: { schemaHash: string; names: string[]; servers: string[]; bytes: number }[]
  shadowedSkills: AuditReport['conflicts']
  /** DSH 未暴露 assembly trace 时，必须保持 unavailable，不能推测裁剪结果。 */
  trimmed: { status: 'unavailable'; items: [] }
  repairPlan: AuditReport['suggestions']
}

/** 审计引擎依赖的服务面（工具执行与 HTTP 路由共用）。 */
export interface AuditDeps {
  fs: FileSystem
  skills: SkillRegistry
  tools: ToolRuntime
}

/** 审计选项。 */
export interface AuditOptions {
  cwd: string
  signal: AbortSignal
  /** 是否统计技能正文总 token（逐个加载正文，较慢）。 */
  includeSkillBodies?: boolean
  /** includeSkillBodies 时最多统计的技能个数。 */
  maxSkillBodies?: number
  /** `developer` 附加可定位的 context-audit receipt；默认只返回摘要。 */
  detail?: 'summary' | 'developer'
  /** 当前执行上下文（工具执行时传入 exec.agent，用于解析会话 cwd）。 */
  agent?: unknown
}

/** 执行一次完整审计。 */
export async function runAudit(deps: AuditDeps, options: AuditOptions): Promise<AuditReport> {
  const { fs, skills, tools } = deps
  const { cwd, signal } = options

  // 技能查询必须带 scope。宿主 SkillViewOptions 写明「omitted reads the global
  // layer alone」，而技能实际注册在调用方所在的 project / runtime / user 层，
  // 不传 scope 时 catalog 恒为空（issue #8）。宿主自己的 tool-skill 就是这个
  // 写法：agent 本身即 scope key。
  const skillLookup = {
    cwd,
    signal,
    ...(typeof options.agent === 'object' && options.agent !== null ? { scope: options.agent } : {}),
  }

  // skills.list 只调一次：技能目录统计与冲突检测共用同一份列表。
  const skillList = await skills.list(skillLookup)

  const [instructions, skillCatalog, toolSchemas] = await Promise.all([
    scanInstructionChain(fs, cwd, signal),
    scanSkillCatalog(skillList, signal),
    scanToolSchemas(tools, options.agent, signal),
  ])

  // 可选：统计技能正文总 token（前 N 个）
  let bodies: { count: number; totalTokens: number } | undefined
  if (options.includeSkillBodies === true) {
    const max = Math.max(1, Math.min(options.maxSkillBodies ?? 20, 100))
    let count = 0
    let totalTokens = 0
    for (const summary of skillList.slice(0, max)) {
      try {
        const def = await skills.get(summary.name, skillLookup)
        if (def !== undefined) {
          count++
          totalTokens += estimateTokens(def.content)
        }
      } catch {
        // 单个技能加载失败不影响整体
      }
    }
    bodies = { count, totalTokens }
  }

  const conflicts = findRankShadows(skillList.map((s) => ({
    name: s.name,
    source: s.source,
    provider: s.provider,
    rank: rankOfSource(s.source),
  })))

  const suggestions = buildSuggestions({
    instructions,
    skills: { ...skillCatalog, ...(bodies !== undefined ? { bodies } : {}) },
    tools: toolSchemas,
    conflicts,
  })

  const report: AuditReport = {
    tool: 'context_audit',
    version: 1,
    cwd,
    injected: {
      instructions: {
        root: instructions.root,
        files: instructions.files,
        totalTokens: instructions.totalTokens,
        duplicateBlocks: instructions.duplicateBlocks.map((b) => ({ tokens: b.tokens, paths: b.paths })),
      },
      skills: {
        catalogCount: skillCatalog.count,
        catalogDescriptionTokens: skillCatalog.totalDescriptionTokens,
        bySource: skillCatalog.bySource,
        duplicateDescriptions: skillCatalog.duplicateDescriptions,
        ...(bodies !== undefined ? { bodies } : {}),
      },
      tools: {
        visibleCount: toolSchemas.visibleCount,
        schemaTokens: toolSchemas.schemaTokens,
        nativeCount: toolSchemas.nativeCount,
        nativeTokens: toolSchemas.nativeTokens,
        mcp: toolSchemas.mcp,
      },
    },
    conflicts,
    suggestions,
  }

  if (options.detail === 'developer') {
    report.receipt = buildDeveloperReceipt({
      instructions,
      skillList,
      toolSchemas,
      conflicts,
      suggestions,
    })
  }
  return report
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function preview(value: string, max = 160): string {
  const compact = value.replace(/\s+/g, ' ').trim()
  return compact.length <= max ? compact : `${compact.slice(0, max - 1)}…`
}

function buildDeveloperReceipt(input: {
  instructions: Awaited<ReturnType<typeof scanInstructionChain>>
  skillList: Awaited<ReturnType<SkillRegistry['list']>>
  toolSchemas: Awaited<ReturnType<typeof scanToolSchemas>>
  conflicts: AuditReport['conflicts']
  suggestions: AuditReport['suggestions']
}): ContextAuditReceipt {
  const agentsFiles = input.instructions.files.map((file, index) => ({
    ...file,
    loadOrder: index + 1,
    duplicateBlocks: input.instructions.duplicateBlocks
      .filter(block => block.paths.includes(file.path))
      .map(block => ({ sha256: sha256(block.text), tokens: block.tokens, paths: block.paths, preview: preview(block.text) })),
  }))
  const skills = input.skillList.map(skill => ({
    name: skill.name,
    source: skill.source,
    provider: skill.provider,
    descriptionBytes: byteLength(skill.description),
    descriptionTokens: estimateTokens(skill.description),
    catalogInjected: true as const,
  }))
  const schemaItems = input.toolSchemas.items.map(item => ({
    name: item.name,
    bytes: item.bytes,
    tokens: item.tokens,
    schemaHash: item.schemaHash,
    ...(item.server !== undefined ? { server: item.server } : {}),
  }))
  const duplicateMcpEntries = [...input.toolSchemas.mcpDuplicates.entries()]
    .filter(([, items]) => items.length > 1)
    .map(([schemaHash, items]) => ({
      schemaHash,
      names: items.map(item => item.name).sort(),
      servers: [...new Set(items.map(item => item.server))].sort(),
      bytes: items.reduce((total, item) => total + item.bytes, 0),
    }))
    .sort((a, b) => b.bytes - a.bytes || a.schemaHash.localeCompare(b.schemaHash))

  return {
    kind: 'context-audit-receipt',
    version: 1,
    detail: 'developer',
    agentsFiles,
    skills,
    toolSchemas: { totalBytes: schemaItems.reduce((total, item) => total + item.bytes, 0), items: schemaItems },
    duplicateMcpEntries,
    shadowedSkills: input.conflicts,
    trimmed: { status: 'unavailable', items: [] },
    repairPlan: input.suggestions,
  }
}

/** SkillSummary 的 rank 不在公开类型里；按来源给启发式排序值（与官方 rank 语义一致：低者胜）。 */
export function rankOfSource(source: string): number {
  switch (source) {
    case 'project-dsh': return 100
    case 'project-agents': return 200
    case 'runtime': return 250
    case 'user-dsh': return 300
    case 'user-agents': return 400
    case 'custom': return 500
    case 'bundled': return 600
    default: return 900
  }
}

interface SuggestionInput {
  instructions: { totalTokens: number; duplicateBlocks: { tokens: number; paths: string[] }[] }
  skills: {
    count: number
    totalDescriptionTokens: number
    bySource: { source: string; count: number; descriptionTokens: number }[]
    duplicateDescriptions: { name: string; description: string; count: number }[]
    bodies?: { count: number; totalTokens: number }
  }
  tools: {
    visibleCount: number
    schemaTokens: number
    mcp: { servers: { server: string; tools: number; schemaTokens: number }[]; totalTools: number; totalTokens: number }
  }
  conflicts: { name: string; winner: { source: string; provider: string }; shadowed: { source: string; provider: string }[] }[]
}

/** 按严重度排序的裁剪建议。 */
export function buildSuggestions(input: SuggestionInput): { severity: 'high' | 'medium' | 'low'; text: string }[] {
  const out: { severity: 'high' | 'medium' | 'low'; text: string }[] = []

  if (input.instructions.totalTokens > 8000) {
    out.push({
      severity: 'high',
      text: `指令链总 token 偏高（${formatTokens(input.instructions.totalTokens)}），建议精简 AGENTS.md/CLAUDE.md，只保留每层独有的规则。`,
    })
  }
  for (const block of input.instructions.duplicateBlocks.slice(0, 5)) {
    out.push({
      severity: 'medium',
      text: `重复段落（${formatTokens(block.tokens)} token）出现在 ${block.paths.length} 个文件：${block.paths.join('、')}。建议只保留一处，其余改为链接。`,
    })
  }

  if (input.skills.totalDescriptionTokens > 3000) {
    out.push({
      severity: 'medium',
      text: `技能 catalog 摘要占用 ${formatTokens(input.skills.totalDescriptionTokens)} token（${input.skills.count} 个技能，每个请求都会携带），建议缩短 description 或减少技能数量。`,
    })
  }
  for (const dup of input.skills.duplicateDescriptions.slice(0, 5)) {
    out.push({
      severity: 'medium',
      text: `${dup.count} 个技能描述完全相同（如「${dup.name}」），catalog 存在冗余，建议合并或差异化描述。`,
    })
  }
  if (input.skills.bodies !== undefined && input.skills.bodies.totalTokens > 20000) {
    out.push({
      severity: 'low',
      text: `已统计 ${input.skills.bodies.count} 个技能正文，共约 ${formatTokens(input.skills.bodies.totalTokens)} token（按需加载，不常驻请求）。`,
    })
  }

  if (input.tools.mcp.totalTokens > 4000 || input.tools.mcp.totalTools > 20) {
    out.push({
      severity: 'high',
      text: `MCP 工具面膨胀：${input.tools.mcp.totalTools} 个工具、schema 约 ${formatTokens(input.tools.mcp.totalTokens)} token。最大服务器：${input.tools.mcp.servers.slice(0, 3).map((s) => `${s.server}(${s.tools} 工具)`).join('、')}。建议裁剪不需要的服务器或工具。`,
    })
  }
  if (input.tools.visibleCount > 40) {
    out.push({
      severity: 'low',
      text: `可见工具共 ${input.tools.visibleCount} 个（schema 约 ${formatTokens(input.tools.schemaTokens)} token），每个请求都会携带，建议检查是否全部需要。`,
    })
  }

  for (const conflict of input.conflicts.slice(0, 5)) {
    out.push({
      severity: 'medium',
      text: `技能「${conflict.name}」存在多个来源：${conflict.winner.source}(${conflict.winner.provider}) 胜出，${conflict.shadowed.map((s) => `${s.source}(${s.provider})`).join('、')} 被 shadow，模型只会加载胜出者。`,
    })
  }

  return out
}

/** 把 canonical 报告渲染成模型可读文本。 */
export function renderReport(report: AuditReport): string {
  const lines: string[] = []
  lines.push(`# Context Doctor 审计报告（cwd: ${report.cwd}）`)
  lines.push('')

  const inst = report.injected.instructions
  lines.push(`## 1. 指令链（AGENTS.md / CLAUDE.md）`)
  lines.push(`- 注入文件：${inst.files.length} 个，共 ${formatTokens(inst.totalTokens)} token`)
  for (const f of inst.files) {
    lines.push(`  - ${f.path}（${formatTokens(f.tokens)} token / ${formatBytes(f.bytes)}）`)
  }
  if (inst.duplicateBlocks.length > 0) {
    lines.push(`- ⚠ 跨文件重复段落：${inst.duplicateBlocks.length} 处`)
    for (const b of inst.duplicateBlocks.slice(0, 5)) {
      lines.push(`  - ${formatTokens(b.tokens)} token × ${b.paths.length} 文件：${b.paths.join('、')}`)
    }
  } else {
    lines.push('- 未发现跨文件重复段落')
  }
  lines.push('')

  const sk = report.injected.skills
  lines.push(`## 2. 技能目录（catalog，每请求常驻）`)
  lines.push(`- ${sk.catalogCount} 个技能，摘要共 ${formatTokens(sk.catalogDescriptionTokens)} token`)
  for (const s of sk.bySource) {
    lines.push(`  - ${s.source}: ${s.count} 个 / ${formatTokens(s.descriptionTokens)} token`)
  }
  if (sk.bodies !== undefined) {
    lines.push(`- 技能正文（按需加载）：已统计 ${sk.bodies.count} 个，共约 ${formatTokens(sk.bodies.totalTokens)} token`)
  }
  if (sk.duplicateDescriptions.length > 0) {
    lines.push(`- ⚠ 描述重复：${sk.duplicateDescriptions.length} 组`)
    for (const d of sk.duplicateDescriptions.slice(0, 5)) {
      lines.push(`  - ${d.count} 个技能共用描述（如「${d.name}」）`)
    }
  }
  lines.push('')

  const tl = report.injected.tools
  lines.push(`## 3. 工具 schema（每请求常驻）`)
  lines.push(`- 可见工具 ${tl.visibleCount} 个，schema 共 ${formatTokens(tl.schemaTokens)} token（其中原生 ${tl.nativeCount} 个 / ${formatTokens(tl.nativeTokens)} token）`)
  if (tl.mcp.totalTools > 0) {
    lines.push(`- MCP：${tl.mcp.totalTools} 个工具 / ${formatTokens(tl.mcp.totalTokens)} token`)
    for (const s of tl.mcp.servers) {
      lines.push(`  - ${s.server}: ${s.tools} 工具 / ${formatTokens(s.schemaTokens)} token`)
    }
  }
  lines.push('')

  if (report.conflicts.length > 0) {
    lines.push(`## 4. 同名技能冲突（rank shadow）`)
    for (const c of report.conflicts) {
      lines.push(`- ${c.name}: ${c.winner.source}(${c.winner.provider}) 胜出；${c.shadowed.map((s) => `${s.source}(${s.provider})`).join('、')} 被 shadow`)
    }
    lines.push('')
  }

  lines.push(`## 5. 建议（${report.suggestions.length} 条）`)
  if (report.suggestions.length === 0) {
    lines.push('- 未发现明显问题，当前注入面健康。')
  }
  for (const s of report.suggestions) {
    lines.push(`- [${s.severity}] ${s.text}`)
  }

  if (report.receipt !== undefined) {
    const receipt = report.receipt
    lines.push('')
    lines.push('## Developer context-audit receipt')
    lines.push(`- AGENTS files: ${receipt.agentsFiles.length}`)
    for (const file of receipt.agentsFiles) {
      lines.push(`  - #${file.loadOrder} ${file.path}: ${formatBytes(file.bytes)} / ${formatTokens(file.tokens)} token`)
      for (const duplicate of file.duplicateBlocks) {
        lines.push(`    - duplicate ${duplicate.sha256.slice(0, 12)}… (${formatTokens(duplicate.tokens)} token): ${duplicate.preview}`)
      }
    }
    lines.push(`- Catalog-injected skills: ${receipt.skills.length}`)
    for (const skill of receipt.skills) {
      lines.push(`  - ${skill.name} [${skill.source}/${skill.provider}]: ${formatBytes(skill.descriptionBytes)} / ${formatTokens(skill.descriptionTokens)} token`)
    }
    lines.push(`- Tool schemas: ${formatBytes(receipt.toolSchemas.totalBytes)} serialized across ${receipt.toolSchemas.items.length} tools`)
    for (const duplicate of receipt.duplicateMcpEntries) {
      lines.push(`  - duplicate MCP signature ${duplicate.schemaHash}: ${duplicate.names.join('、')} (${formatBytes(duplicate.bytes)})`)
    }
    lines.push(`- Shadowed skills: ${receipt.shadowedSkills.length}`)
    lines.push(`- Trimmed entries: ${receipt.trimmed.status} (DSH assembly trace is not exposed)`)
  }

  return lines.join('\n')
}
