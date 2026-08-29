#!/usr/bin/env node
/**
 * setup-dsh-deps — 把本插件的开发依赖指向本机 DSH checkout。
 *
 * 插件源码 import 的 `@deepseek-ai/*` 与 `cordis` 类型来自 DSH 源码检出
 * （workspace 包 + vendored 框架），不在 npm 上。本脚本：
 *
 * 1. 定位 DSH checkout（`dsh` 在 PATH 时从 bin 反推；否则用 DSH_HOME；
 *    再否则尝试常见位置），校验 packages/ 存在；
 * 2. 重建 node_modules 下的依赖软链（@deepseek-ai/*、cordis、schemastery、
 *    react、@types 等）；
 * 3. 把 tsconfig.json 的 compilerOptions.paths 前缀重写为 checkout 路径。
 *
 * 用法：node scripts/setup-dsh-deps.mjs [--checkout <path>]
 * 之后即可 `node <checkout>/node_modules/.bin/tsc -p tsconfig.json` 或
 * `pnpm run build`（需要 DSH 检出的 tsc/tsdown 在 PATH 可解析）。
 */
import { existsSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 依赖名 → checkout 内相对路径。 */
const LINKS = {  'node_modules/@deepseek-ai/cordis': 'vendor/cordis',
  'node_modules/schemastery': 'vendor/schemastery',
  'node_modules/cosmokit': 'vendor/cosmokit',
  'node_modules/react': 'node_modules/.pnpm/react@18.3.1/node_modules/react',
  'node_modules/lightningcss': 'node_modules/lightningcss',
  'node_modules/tsdown': 'node_modules/tsdown',
  'node_modules/@types': 'node_modules/@types',
  'node_modules/@deepseek-ai/dsh-agent': 'packages/core/agent',
  'node_modules/@deepseek-ai/dsh-brand': 'packages/util/brand',
  'node_modules/@deepseek-ai/dsh-tools': 'packages/core/tools',
  'node_modules/@deepseek-ai/dsh-fs': 'packages/fs/fs',
  'node_modules/@deepseek-ai/dsh-skill': 'packages/skill/skill',
  'node_modules/@deepseek-ai/dsh-host-webserver': 'packages/host/webserver',
  'node_modules/@deepseek-ai/dsh-client-store': 'packages/client/store',
  'node_modules/@deepseek-ai/dsh-client-modules': 'packages/client/modules',
  'node_modules/@deepseek-ai/dsh-client-ui-slots': 'packages/client/ui-slots',
  'node_modules/@deepseek-ai/dsh-client-ui-renderer': 'packages/client/ui-renderer',
  'node_modules/@deepseek-ai/dsh-client-ui-conversation': 'packages/client/ui-conversation',
  'node_modules/@deepseek-ai/dsh-client-locale': 'packages/client/locale',
  'node_modules/@deepseek-ai/dsh-client-connection': 'packages/client/connection',
  'node_modules/@deepseek-ai/dsh-llm': 'packages/llm/llm',
  'node_modules/@deepseek-ai/dsh-session': 'packages/core/session',
  'node_modules/@deepseek-ai/dsh-scope': 'packages/core/scope',
  'node_modules/@deepseek-ai/dsh-code-runtime': 'packages/code-runtime/code-runtime',
  'node_modules/@deepseek-ai/dsh-sandbox': 'packages/sandbox/sandbox',
  'node_modules/@deepseek-ai/dsh-invariants': 'packages/runtime-diagnostics/invariants',
  'node_modules/@deepseek-ai/dsh-system-prompt': 'packages/core/system-prompt',
  'node_modules/@deepseek-ai/dsh-timeout': 'packages/util/timeout',
  'node_modules/@deepseek-ai/dsh-user-approval': 'packages/interaction/user-approval',
}

/** 常见 DSH 源码检出位置（dsh 不在 PATH 时的兜底）。 */
const COMMON_CHECKOUTS = [
  join(process.env.DSH_HOME ?? '', 'source', 'current'),
  join(process.env.HOME ?? '', '.dsh', 'source', 'current'),
]

function fail(message) {
  console.error(`setup-dsh-deps: ${message}`)
  process.exit(1)
}

/** 从 `dsh` bin 反推 checkout 根（bin 在 <checkout>/bin/dsh）。 */
function checkoutFromDshBin() {
  try {
    const out = execFileSync('bash', ['-lc', 'readlink -f "$(command -v dsh)"'], { encoding: 'utf8' }).trim()
    if (out === '') return undefined
    const binDir = dirname(out)
    return resolve(binDir, '..')
  } catch {
    return undefined
  }
}

function resolveCheckout(explicit) {
  if (explicit !== undefined && existsSync(join(explicit, 'packages'))) return resolve(explicit)
  for (const candidate of [checkoutFromDshBin(), ...COMMON_CHECKOUTS]) {
    if (candidate !== undefined && existsSync(join(candidate, 'packages'))) return candidate
  }
  fail(`无法定位 DSH checkout：dsh 不在 PATH，且常见位置不存在。用 --checkout <path> 显式指定（需含 packages/ 目录）。`)
}

/** 重建一个软链（先删旧链接；真实目录则跳过不动）。 */
function relink(target, source) {
  let current
  try {
    current = readlinkSync(target) // dangling symlink 也能读
  } catch (error) {
    if (error.code !== 'ENOENT') return // 真实目录或非链接：不动
  }
  if (current !== undefined) {
    if (resolve(current) === resolve(source)) return
    unlinkSync(target)
  }
  mkdirSync(dirname(target), { recursive: true })
  symlinkSync(source, target, 'dir')
}

const argCheckout = process.argv.indexOf('--checkout')
const explicit = argCheckout >= 0 ? process.argv[argCheckout + 1] : undefined

const checkout = resolveCheckout(explicit)
console.log(`setup-dsh-deps: DSH checkout = ${checkout}`)

// 1. 依赖软链
let linked = 0
for (const [target, rel] of Object.entries(LINKS)) {
  const source = join(checkout, rel)
  if (!existsSync(source)) {
    console.warn(`  skip ${target}: checkout 缺少 ${rel}`)
    continue
  }
  relink(join(ROOT, target), source)
  linked++
}
console.log(`setup-dsh-deps: ${linked} 个依赖软链已就位`)

// 2. tsconfig paths 重写（前缀统一为 checkout 路径）
const tsconfigPath = join(ROOT, 'tsconfig.json')
const tsconfig = JSON.parse(readFileSync(tsconfigPath, 'utf8'))
const paths = tsconfig.compilerOptions?.paths
if (paths !== undefined) {
  let changed = 0
  for (const [name, targets] of Object.entries(paths)) {
    paths[name] = targets.map((t) => {
      // 非贪婪匹配 checkout 前缀：捕获紧邻的 packages/ 或 node_modules/ 段名，
      // 段名之后的内容（含 .pnpm 等）原样保留。
      const m = /^\/[^/]+(?:\/[^/]+)*?\/(packages\/|node_modules\/)/.exec(t)
      if (m !== null && !t.startsWith(`${checkout}/`)) {
        changed++
        return join(checkout, m[1] + t.slice(m[0].length))
      }
      return t
    })
  }
  if (changed > 0) {
    writeFileSync(tsconfigPath, `${JSON.stringify(tsconfig, null, 2)}\n`)
    console.log(`setup-dsh-deps: tsconfig.json paths 已重写 ${changed} 处 → ${checkout}`)
  } else {
    console.log('setup-dsh-deps: tsconfig.json paths 无需改动')
  }
}

console.log('setup-dsh-deps: 完成。构建：node <checkout>/node_modules/.bin/tsc -p tsconfig.json && node <checkout>/node_modules/.bin/tsdown -c tsdown.config.ts --tsconfig tsconfig.down.json')
