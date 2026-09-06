/**
 * Host 侧文案分层（issue #11）。
 *
 * 报告与建议是给人读的，跟随宿主语言；工具 schema 是给模型读的，固定英文。
 * 这里锁住语言解析、两套词典的键一致性，以及渲染确实随语言变化。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HOST_MESSAGE_KEYS, hostTranslate, resolveHostLocale } from '../src/locale.ts'
import { buildSuggestions, renderReport } from '../src/audit.ts'
import type { AuditReport } from '../src/audit.ts'

test('resolveHostLocale: 只认 zh，其余一律回退英文', () => {
  for (const zh of ['zh', 'zh-CN', 'zh-Hans', 'ZH-TW']) {
    assert.equal(resolveHostLocale(zh), 'zh', `${zh} 应解析为 zh`)
  }
  // 缺省即「跟随浏览器」，host 看不见浏览器，只能回退英文。
  for (const other of ['en', 'en-US', 'fr', '', undefined, null, 42, {}]) {
    assert.equal(resolveHostLocale(other), 'en', `${String(other)} 应回退 en`)
  }
})

test('hostTranslate: 两套词典键集一致且都非空', () => {
  const en = hostTranslate('en')
  const zh = hostTranslate('zh')
  assert.ok(HOST_MESSAGE_KEYS.length > 20, '键集不应为空')
  for (const key of HOST_MESSAGE_KEYS) {
    assert.ok(en(key).length > 0, `en 缺 ${key}`)
    assert.ok(zh(key).length > 0, `zh 缺 ${key}`)
  }
})

test('hostTranslate: 占位符按名替换，未提供的原样保留', () => {
  const t = hostTranslate('en')
  assert.ok(t('r.title', { cwd: '/tmp/x' }).includes('/tmp/x'))
  assert.ok(t('r.title').includes('{cwd}'), '未传参时占位符保持原样')
})

/** 最小报告骨架。 */
function emptyReport(): AuditReport {
  return {
    tool: 'context_audit',
    version: 1,
    cwd: '/tmp/x',
    injected: {
      instructions: { root: '/tmp/x', files: [], totalTokens: 0, duplicateBlocks: [] },
      skills: { catalogCount: 0, catalogDescriptionTokens: 0, bySource: [], duplicateDescriptions: [] },
      tools: { visibleCount: 0, schemaTokens: 0, nativeCount: 0, nativeTokens: 0, mcp: { servers: [], totalTools: 0, totalTokens: 0 } },
    },
    conflicts: [],
    suggestions: [],
  }
}

test('renderReport: 默认英文，指定 zh 时输出中文', () => {
  const report = emptyReport()
  const en = renderReport(report)
  const zh = renderReport(report, 'zh')

  assert.ok(en.includes('# Context Doctor audit report'))
  assert.ok(en.includes('Instruction chain'))
  assert.ok(zh.includes('# Context Doctor 审计报告'))
  assert.ok(zh.includes('指令链'))
  assert.notEqual(en, zh)
})

test('buildSuggestions: 建议文案随语言变化', () => {
  const input = {
    instructions: { totalTokens: 9000, duplicateBlocks: [] },
    skills: { count: 0, totalDescriptionTokens: 0, duplicateDescriptions: [] },
    tools: { visibleCount: 0, schemaTokens: 0, mcp: { servers: [], totalTools: 0, totalTokens: 0 } },
    conflicts: [],
  } as unknown as Parameters<typeof buildSuggestions>[0]

  const en = buildSuggestions(input)
  const zh = buildSuggestions(input, 'zh')

  assert.equal(en.length, 1)
  assert.equal(en[0]!.severity, 'high')
  assert.ok(en[0]!.text.includes('instruction chain'))
  assert.ok(zh[0]!.text.includes('指令链'))
})
