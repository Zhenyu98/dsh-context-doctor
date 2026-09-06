import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { apply, inject, name, type AuditReport } from '../src/index.ts'

/** 构造一个最小可用的 mock ctx（覆盖 apply 用到的全部服务）。 */
function makeCtx(workspaceDir: string, skills: unknown[] = [], toolSchemas: unknown[] = []) {
  const fs = {
    async resolve(path: string, opts?: { cwd?: string }): Promise<unknown> {
      return { targetKey: resolve(opts?.cwd ?? process.cwd(), path) }
    },
    processPath(target: { targetKey: string }): string {
      return target.targetKey
    },
    async stat(target: { targetKey: string }): Promise<unknown> {
      try {
        const st = statSync(target.targetKey)
        return { version: 1, type: st.isDirectory() ? 'directory' : 'file', size: st.size }
      } catch {
        return undefined
      }
    },
    async readText(target: { targetKey: string }): Promise<string> {
      return readFileSync(target.targetKey, 'utf8')
    },
  }
  const skillSummaries = skills.map((s: { name: string; description: string; source?: string; provider?: string }) => ({
    ...s,
    source: s.source ?? 'user-dsh',
    provider: s.provider ?? 'skill-local',
    invocation: { modelInvocable: true, userInvocable: false },
  }))
  return {
    fs,
    skills: {
      list: async () => skillSummaries,
      get: async (s: string) => ({ name: s, description: '', content: '正文内容', source: 'user-dsh', provider: 'skill-local' }),
    },
    tools: {
      schemas: () => toolSchemas,
    },
    webServer: {
      register: () => () => {},
    },
    sessions: {
      get: () => undefined,
    },
    effect: (fn: () => unknown) => fn(),
    inject: (_name: string, fn: (httpCtx: { webServer: unknown; effect: (f: unknown) => unknown }) => unknown) =>
      fn({ webServer: { register: () => () => {} }, effect: (f: unknown) => (f as () => unknown)() }),
    get: () => undefined,
    toolsRegistered: [] as unknown[],
    register: function (def: unknown) { this.toolsRegistered.push(def) },
  }
}

test('插件入口：apply 注册 context_audit 工具', () => {
  const ctx = makeCtx(process.cwd())
  // 把 register 挂到 ctx.tools 上
  const registered: unknown[] = []
  ctx.tools.register = (def: unknown) => { registered.push(def) }
  apply(ctx as never)
  assert.equal(name, 'context-doctor')
  assert.deepEqual(inject, ['fs', 'skills', 'tools', 'sessions'])
  assert.equal(registered.length, 1)
  const tool = registered[0] as { name: string; description: string; parameters: { properties: Record<string, unknown> }; execute: Function; output: { render: Function } }
  assert.equal(tool.name, 'context_audit')
  assert.ok(tool.description.length > 20)
  assert.ok('cwd' in tool.parameters.properties)
    assert.ok('includeSkillBodies' in tool.parameters.properties)
  assert.ok('detail' in tool.parameters.properties)
  assert.equal(typeof tool.execute, 'function')
})

test('插件入口：无 webServer 环境（headless）下工具仍注册、路由跳过', () => {
  const ctx = makeCtx(process.cwd())
  // 模拟 headless：inject 回调不执行（webServer 服务不存在）
  ctx.inject = () => {}
  const registered: unknown[] = []
  ctx.tools.register = (def: unknown) => { registered.push(def) }
  apply(ctx as never)
  assert.equal(registered.length, 1)
  const tool = registered[0] as { name: string }
  assert.equal(tool.name, 'context_audit')
})

test('插件端到端：execute 产出完整审计报告', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ctxdoc-plugin-'))
  try {
    const repo = join(dir, 'repo')
    mkdirSync(join(repo, '.git'), { recursive: true })
    const shared = '# 重复规则\n这条规则在两层 AGENTS.md 里完全一样，长度足够长以通过重复检测的最小阈值。\n'
    writeFileSync(join(repo, 'AGENTS.md'), shared)
    const sub = join(repo, 'sub')
    mkdirSync(sub, { recursive: true })
    writeFileSync(join(sub, 'AGENTS.md'), shared + '\n# sub 层规则\n')

    const ctx = makeCtx(process.cwd(), [
      { name: 'skill-a', description: '重复描述' },
      { name: 'skill-b', description: '重复描述' },
      { name: 'shadowed-skill', description: 'project copy', source: 'project-dsh' },
      { name: 'shadowed-skill', description: 'bundled copy', source: 'bundled' },
    ], [
      { name: 'mcp__github__create_issue', description: 'Create an issue', parameters: { type: 'object', properties: {} } },
      { name: 'mcp__tracker__open_issue', description: 'Create an issue', parameters: { type: 'object', properties: {} } },
      { name: 'read_file', description: 'Read a file' },
    ])
    const registered: unknown[] = []
    ctx.tools.register = (def: unknown) => { registered.push(def) }
    apply(ctx as never)
    const tool = registered[0] as { execute: Function }
    const args = { detail: 'developer' }
    const exec = { agent: { session: { header: { cwd: sub } } }, signal: new AbortController().signal }
    const report = await tool.execute(args, exec) as AuditReport

    assert.equal(report.tool, 'context_audit')
    assert.equal(report.cwd, sub)
    // 指令链：repo 与 sub 两层 AGENTS.md
    assert.equal(report.injected.instructions.files.length, 2)
    assert.ok(report.injected.instructions.totalTokens > 0)
    // 重复块
    assert.ok(report.injected.instructions.duplicateBlocks.length >= 1)
    // 技能目录：2 个技能、描述重复
    assert.equal(report.injected.skills.catalogCount, 4)
    assert.ok(report.injected.skills.duplicateDescriptions.length >= 1)
    // 工具：1 原生 + 1 MCP
    assert.equal(report.injected.tools.visibleCount, 3)
    assert.equal(report.injected.tools.mcp.totalTools, 2)
    assert.equal(report.injected.tools.nativeCount, 1)
    // 建议：至少一条（重复段落）
    assert.ok(report.suggestions.length >= 1)

    // 开发者回执：每个条目均可定位，且不存在的 assembly trace 明确标记 unavailable。
    assert.ok(report.receipt)
    assert.equal(report.receipt.kind, 'context-audit-receipt')
    assert.equal(report.receipt.agentsFiles[0]!.loadOrder, 1)
    assert.ok(report.receipt.agentsFiles[0]!.duplicateBlocks[0]!.sha256.length > 20)
    assert.equal(report.receipt.skills.find((skill) => skill.name === 'skill-a')!.catalogInjected, true)
    assert.ok(report.receipt.toolSchemas.totalBytes > 0)
    assert.equal(report.receipt.duplicateMcpEntries.length, 1)
    assert.equal(report.receipt.shadowedSkills[0]!.name, 'shadowed-skill')
    assert.equal(report.receipt.trimmed.status, 'unavailable')

    // render 输出可读文本。mock ctx 没有 settings 服务，语言回退英文——宿主的
    // locale.preference 可缺省，缺省即「跟随浏览器」，而 host 看不见浏览器。
    const render = tool as unknown as { output: { render: Function } }
    const blocks = render.output.render(args, report as never)
    const text = (blocks[0] as { text: string }).text
    assert.ok(text.includes('# Context Doctor audit report'))
    assert.ok(text.includes('Instruction chain'))
    assert.ok(text.includes('Suggestions'))
    assert.ok(text.includes('Developer context-audit receipt'))

    // 工具 schema 固定英文：给模型读的契约，不随宿主语言漂移（issue #11）。
    const schema = tool as unknown as { description: string }
    assert.ok(schema.description.startsWith('Audit what this session injects'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
