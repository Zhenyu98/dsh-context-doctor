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

  // skills.list 只调一次：技能目录统计与冲突检测共用同一份列表。
  const skillList = await skills.list({ cwd, signal })

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
        const def = await skills.get(summary.name, { cwd, signal })
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
      text: `Instruction chain tokens are high (${formatTokens(input.instructions.totalTokens)}); consider trimming AGENTS.md/CLAUDE.md to keep only rules unique to each layer.`,
    })
  }
  for (const block of input.instructions.duplicateBlocks.slice(0, 5)) {
    out.push({
      severity: 'medium',
      text: `Duplicate block (${formatTokens(block.tokens)} tokens) appears in ${block.paths.length} files: ${block.paths.join(', ')}. Keep one copy and turn the others into links.`,
    })
  }

  if (input.skills.totalDescriptionTokens > 3000) {
    out.push({
      severity: 'medium',
      text: `Skill catalog descriptions take ${formatTokens(input.skills.totalDescriptionTokens)} tokens (${input.skills.count} skills, carried on every request); consider shortening descriptions or reducing the number of skills.`,
    })
  }
  for (const dup of input.skills.duplicateDescriptions.slice(0, 5)) {
    out.push({
      severity: 'medium',
      text: `${dup.count} skills have identical descriptions (e.g. "${dup.name}"); the catalog is redundant; merge them or differentiate the descriptions.`,
    })
  }
  if (input.skills.bodies !== undefined && input.skills.bodies.totalTokens > 20000) {
    out.push({
      severity: 'low',
      text: `Counted ${input.skills.bodies.count} skill bodies totaling about ${formatTokens(input.skills.bodies.totalTokens)} tokens (loaded on demand, not resident in requests).`,
    })
  }

  if (input.tools.mcp.totalTokens > 4000 || input.tools.mcp.totalTools > 20) {
    out.push({
      severity: 'high',
      text: `MCP tool surface bloat: ${input.tools.mcp.totalTools} tools with ~${formatTokens(input.tools.mcp.totalTokens)} tokens of schema. Largest servers: ${input.tools.mcp.servers.slice(0, 3).map((s) => `${s.server} (${s.tools} tools)`).join(', ')}. Consider pruning servers or tools you do not need.`,
    })
  }
  if (input.tools.visibleCount > 40) {
    out.push({
      severity: 'low',
      text: `${input.tools.visibleCount} visible tools (~${formatTokens(input.tools.schemaTokens)} tokens of schema) are carried on every request; check whether all of them are needed.`,
    })
  }

  for (const conflict of input.conflicts.slice(0, 5)) {
    out.push({
      severity: 'medium',
      text: `Skill "${conflict.name}" has multiple sources: ${conflict.winner.source}(${conflict.winner.provider}) wins, ${conflict.shadowed.map((s) => `${s.source}(${s.provider})`).join(', ')} are shadowed; only the winner is loaded.`,
    })
  }

  return out
}

/** 把 canonical 报告渲染成模型可读文本。 */
export function renderReport(report: AuditReport): string {
  const lines: string[] = []
  lines.push(`# Context Doctor Audit Report (cwd: ${report.cwd})`)
  lines.push('')

  const inst = report.injected.instructions
  lines.push(`## 1. Instruction chain (AGENTS.md / CLAUDE.md)`)
  lines.push(`- Injected files: ${inst.files.length}, totaling ${formatTokens(inst.totalTokens)} tokens`)
  for (const f of inst.files) {
    lines.push(`  - ${f.path} (${formatTokens(f.tokens)} tokens / ${formatBytes(f.bytes)})`)
  }
  if (inst.duplicateBlocks.length > 0) {
    lines.push(`- ⚠ Cross-file duplicate blocks: ${inst.duplicateBlocks.length}`)
    for (const b of inst.duplicateBlocks.slice(0, 5)) {
      lines.push(`  - ${formatTokens(b.tokens)} tokens × ${b.paths.length} files: ${b.paths.join(', ')}`)
    }
  } else {
    lines.push('- No cross-file duplicate blocks found')
  }
  lines.push('')

  const sk = report.injected.skills
  lines.push(`## 2. Skill catalog (resident on every request)`)
  lines.push(`- ${sk.catalogCount} skills, ${formatTokens(sk.catalogDescriptionTokens)} tokens of descriptions`)
  for (const s of sk.bySource) {
    lines.push(`  - ${s.source}: ${s.count} / ${formatTokens(s.descriptionTokens)} tokens`)
  }
  if (sk.bodies !== undefined) {
    lines.push(`- Skill bodies (loaded on demand): ${sk.bodies.count} counted, about ${formatTokens(sk.bodies.totalTokens)} tokens total`)
  }
  if (sk.duplicateDescriptions.length > 0) {
    lines.push(`- ⚠ Duplicate descriptions: ${sk.duplicateDescriptions.length} groups`)
    for (const d of sk.duplicateDescriptions.slice(0, 5)) {
      lines.push(`  - ${d.count} skills share one description (e.g. "${d.name}")`)
    }
  }
  lines.push('')

  const tl = report.injected.tools
  lines.push(`## 3. Tool schemas (resident on every request)`)
  lines.push(`- ${tl.visibleCount} visible tools, ${formatTokens(tl.schemaTokens)} tokens of schema (${tl.nativeCount} native / ${formatTokens(tl.nativeTokens)} tokens)`)
  if (tl.mcp.totalTools > 0) {
    lines.push(`- MCP: ${tl.mcp.totalTools} tools / ${formatTokens(tl.mcp.totalTokens)} tokens`)
    for (const s of tl.mcp.servers) {
      lines.push(`  - ${s.server}: ${s.tools} tools / ${formatTokens(s.schemaTokens)} tokens`)
    }
  }
  lines.push('')

  if (report.conflicts.length > 0) {
    lines.push(`## 4. Same-name skill conflicts (rank shadow)`)
    for (const c of report.conflicts) {
      lines.push(`- ${c.name}: ${c.winner.source}(${c.winner.provider}) wins; ${c.shadowed.map((s) => `${s.source}(${s.provider})`).join(', ')} shadowed`)
    }
    lines.push('')
  }

  lines.push(`## 5. Suggestions (${report.suggestions.length})`)
  if (report.suggestions.length === 0) {
    lines.push('- No significant issues found; the current injection surface is healthy.')
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
      lines.push(`  - duplicate MCP signature ${duplicate.schemaHash}: ${duplicate.names.join(', ')} (${formatBytes(duplicate.bytes)})`)
    }
    lines.push(`- Shadowed skills: ${receipt.shadowedSkills.length}`)
    lines.push(`- Trimmed entries: ${receipt.trimmed.status} (DSH assembly trace is not exposed)`)
  }

  return lines.join('\n')
}
