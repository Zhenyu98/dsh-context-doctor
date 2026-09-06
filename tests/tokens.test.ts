import { test } from 'node:test'
import assert from 'node:assert/strict'
import { estimateTokens, formatBytes, formatTokens } from '../src/tokens.ts'

test('estimateTokens: 英文约 4 字符/token', () => {
  assert.equal(estimateTokens('abcd'), 1)
  assert.equal(estimateTokens('a'.repeat(100)), 25)
})

test('estimateTokens: 中文约 1.5 字符/token', () => {
  const zh = '上下文注入审计'
  const tokens = estimateTokens(zh)
  assert.equal(tokens, Math.ceil(zh.length / 1.5))
})

test('estimateTokens: 混合文本取整', () => {
  const mixed = 'hello 你好 world 世界'
  const ascii = 'hello world '.length
  const nonAscii = '你好世界'.length
  assert.equal(estimateTokens(mixed), Math.ceil(ascii / 4 + nonAscii / 1.5))
})

test('estimateTokens: 空文本为 0', () => {
  assert.equal(estimateTokens(''), 0)
})

test('formatTokens: 千分位缩写', () => {
  assert.equal(formatTokens(1234), '1.2k')
  assert.equal(formatTokens(999), '999')
  // 整千不带无意义的 .0。面板与报告此前各有一份实现，正是在这里漂移的：
  // 同一个 50000，报告显示 "50.0k"、面板显示 "50k"。
  assert.equal(formatTokens(12000), '12k')
  assert.equal(formatTokens(50000), '50k')
  assert.equal(formatTokens(123456), '123k')
})

test('formatBytes: 单位换算', () => {
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(2048), '2.0 KB')
  assert.equal(formatBytes(2 * 1024 * 1024), '2.0 MB')
})
