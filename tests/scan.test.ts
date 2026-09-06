import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { MAX_FILE_BYTES, scanInstructionChain } from '../src/scan.ts'

/** 基于 node:fs 的最小 FileSystem 假实现（只覆盖 scan 用到的子集）。 */
function fakeFs(): FileSystem {
  const fs = {
    async resolve(path: string, opts?: { cwd?: string }): Promise<unknown> {
      // 真实实现会把绝对路径原样归一化；这里用 resolve 模拟（join 不会重置绝对路径）
      return { targetKey: resolve(opts?.cwd ?? process.cwd(), path) }
    },
    processPath(target: { targetKey: string }): string {
      return target.targetKey
    },
    async stat(target: { targetKey: string }): Promise<unknown> {
      try {
        const st = statSync(target.targetKey)
        return {
          version: 1,
          type: st.isDirectory() ? 'directory' : st.isFile() ? 'file' : 'other',
          size: st.size,
        }
      } catch {
        return undefined
      }
    },
    async readText(target: { targetKey: string }): Promise<string> {
      return readFileSync(target.targetKey, 'utf8')
    },
  }
  return fs as unknown as FileSystem
}

test('scanInstructionChain: 多层指令链 + git root + 重复检测', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ctxdoc-'))
  try {
    // tmp/repo/.git + tmp/repo/AGENTS.md + tmp/repo/sub/AGENTS.md + tmp/repo/sub/CLAUDE.md
    const repo = join(dir, 'repo')
    mkdirSync(join(repo, '.git'), { recursive: true })
    mkdirSync(join(repo, 'sub'), { recursive: true })
    const shared = '# 全局规则\n这条规则在两个文件里完全一样，长度需要超过四十个字符才能通过最小长度过滤，这里写长一点。\n'
    writeFileSync(join(repo, 'AGENTS.md'), shared + '\n# repo 层规则\n')
    writeFileSync(join(repo, 'sub', 'AGENTS.md'), shared + '\n# sub 层规则\n')
    writeFileSync(join(repo, 'sub', 'CLAUDE.md'), '# 仅 CLAUDE 有\n')

    const fs = fakeFs()
    const result = await scanInstructionChain(fs, join(repo, 'sub'), new AbortController().signal)

    assert.equal(result.root, repo)
    assert.equal(result.files.length, 3)
    const paths = result.files.map((f) => f.path)
    assert.ok(paths.includes(join(repo, 'AGENTS.md')))
    assert.ok(paths.includes(join(repo, 'sub', 'AGENTS.md')))
    assert.ok(paths.includes(join(repo, 'sub', 'CLAUDE.md')))
    assert.ok(result.totalTokens > 0)

    // 重复块：shared 段落跨两个 AGENTS.md
    assert.equal(result.duplicateBlocks.length, 1)
    assert.equal(result.duplicateBlocks[0]!.paths.length, 2)
    assert.ok(result.duplicateBlocks[0]!.text.includes('全局规则'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('scanInstructionChain: 超过大小上限的文件被跳过', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ctxdoc-'))
  try {
    const repo = join(dir, 'repo')
    mkdirSync(join(repo, '.git'), { recursive: true })
    const big = 'x'.repeat(MAX_FILE_BYTES + 1024)
    writeFileSync(join(repo, 'AGENTS.md'), big)
    writeFileSync(join(repo, 'CLAUDE.md'), '# 小文件\n')

    const fs = fakeFs()
    const result = await scanInstructionChain(fs, repo, new AbortController().signal)
    assert.equal(result.files.length, 1)
    assert.ok(result.files[0]!.path.endsWith('CLAUDE.md'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('scanInstructionChain: 无 .git 时以 cwd 为根', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ctxdoc-'))
  try {
    const plain = join(dir, 'plain')
    mkdirSync(plain, { recursive: true })
    writeFileSync(join(plain, 'AGENTS.md'), '# 无 git 仓库\n')

    const fs = fakeFs()
    const result = await scanInstructionChain(fs, plain, new AbortController().signal)
    assert.equal(result.root, plain)
    assert.equal(result.files.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('scanInstructionChain: 符号链接指向同一物理文件时只算一次（issue #8）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ctxdoc-link-'))
  try {
    const repo = join(dir, 'repo')
    mkdirSync(join(repo, '.git'), { recursive: true })
    const body = '# 规则\n这段内容要够长才能进入重复块检测，凑够四十个字符以上，这里多写一些字。\n'
    writeFileSync(join(repo, 'AGENTS.md'), body)

    // CLAUDE.md 是 AGENTS.md 的符号链接：resolve 后归一到同一 targetKey，
    // 正是 deepseek-harness 仓库根目录的布局。
    const real = join(repo, 'AGENTS.md')
    const linkedFs = {
      async resolve(path: string): Promise<unknown> {
        const abs = resolve(path)
        return { targetKey: abs.endsWith('CLAUDE.md') ? real : abs }
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
    } as unknown as FileSystem

    const result = await scanInstructionChain(linkedFs, repo, new AbortController().signal)

    assert.equal(result.files.length, 1, '同一物理文件只应计一次')
    assert.equal(result.files[0]!.path, real)
    // token 不能翻倍，重复块也不能出现「自己和自己重复」
    assert.equal(result.totalTokens, result.files[0]!.tokens)
    assert.deepEqual(result.duplicateBlocks, [], '同一文件自比不应产生重复块')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('scanInstructionChain: 两个独立文件内容逐字节相同时只算一次（issue #8）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ctxdoc-same-'))
  try {
    const repo = join(dir, 'repo')
    mkdirSync(join(repo, '.git'), { recursive: true })
    const body = '# 同样的内容\n宿主的注入链在两份内容相同时只注入一份，审计要对齐这个行为才不会虚高。\n'
    writeFileSync(join(repo, 'AGENTS.md'), body)
    writeFileSync(join(repo, 'CLAUDE.md'), body)

    const result = await scanInstructionChain(fakeFs(), repo, new AbortController().signal)

    assert.equal(result.files.length, 1, '内容相同只应计一次')
    assert.equal(result.totalTokens, result.files[0]!.tokens)
    assert.deepEqual(result.duplicateBlocks, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
