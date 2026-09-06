/**
 * 技能查询必须带 scope（issue #8 Bug 2）。
 *
 * 宿主 `SkillViewOptions` 写明「omitted reads the global layer alone」，而技能
 * 实际注册在调用方所在的 project / runtime / user 层。不传 scope 时 catalog
 * 恒为空，面板和工具报告会整段漏掉技能目录这一项。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runAudit } from '../src/audit.ts'
import type { AuditDeps } from '../src/audit.ts'

/** 记录 skills 查询入参的最小 deps 桩。 */
function stubDeps(): { deps: AuditDeps; lookups: Record<string, unknown>[] } {
  const lookups: Record<string, unknown>[] = []
  const deps = {
    fs: {
      async resolve() { throw new Error('no file') },
      processPath(t: { targetKey: string }) { return t.targetKey },
      async stat() { return undefined },
      async readText() { return '' },
    },
    skills: {
      async list(options: Record<string, unknown>) { lookups.push(options); return [] },
      async get(_name: string, options: Record<string, unknown>) { lookups.push(options); return undefined },
    },
    tools: {},
  } as unknown as AuditDeps
  return { deps, lookups }
}

test('runAudit: 传入 agent 时 skills 查询带上 scope', async () => {
  const { deps, lookups } = stubDeps()
  const agent = { id: 'agent-1' }

  await runAudit(deps, { cwd: '/tmp/proj', signal: new AbortController().signal, agent })

  assert.ok(lookups.length > 0, 'skills.list 应被调用')
  assert.equal(lookups[0]!.scope, agent, 'scope 必须是 agent 本身（宿主以对象身份分层）')
  assert.equal(lookups[0]!.cwd, '/tmp/proj')
})

test('runAudit: 没有 agent 时不伪造 scope', async () => {
  const { deps, lookups } = stubDeps()

  await runAudit(deps, { cwd: '/tmp/proj', signal: new AbortController().signal })

  assert.ok(lookups.length > 0)
  assert.ok(!('scope' in lookups[0]!), '缺少 agent 时不应带 scope 键')
})

test('runAudit: 技能正文查询复用同一份 lookup（含 scope）', async () => {
  const { deps, lookups } = stubDeps()
  const agent = { id: 'agent-2' }

  await runAudit(deps, {
    cwd: '/tmp/proj',
    signal: new AbortController().signal,
    agent,
    includeSkillBodies: true,
  })

  for (const lookup of lookups) {
    assert.equal(lookup.scope, agent)
  }
})
