/**
 * Self-contained tsdown preset for this package's dshClient browser bundle —
 * a port of the DSH checkout's `packages/client/tsdown.client.ts` (the
 * official standard for dshClient plugin bundles), kept dependency-free so
 * this repo builds standalone with no harness project references (git
 * installs transpile through the `prepare` script, like the turtle-ui
 * example). It must not import anything from the DSH monorepo.
 *
 * Emits the closure-factory artifact the loader expects: the bundle calls
 * `window.__ModuleLoader__.load({id, factory})` and resolves externals
 * through the injected require (the loader module table — cordis DI
 * entities, no globals, no import map). CSS Modules are compiled by
 * lightningcss inside the bundle: importing `x.module.css` yields the
 * hashed class map, and the css text auto-injects a `<style data-plugin>`
 * tag at factory execution (the loader removes plugin-owned tags on
 * unload).
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname, resolve as resolvePath, sep } from 'node:path'
import type { UserConfig } from 'tsdown'
import { transform } from 'lightningcss'

/**
 * Virtual-id wrapper keeping module CSS away from tsdown's own css pipeline
 * (which requires @tsdown/css). The suffix matters: tsdown's guard matches
 * ids ending in `.css`, so the virtual id must not.
 */
const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

/**
 * Externals resolved from the loader module table: the shared browser
 * platform modules the shell seeds (mirror of the checkout's
 * `packages/client/web/src/platform.ts` PLATFORM_MODULES) plus the runtime
 * store exemption. Anything else is inlined into the bundle.
 */
const CLIENT_EXTERNALS: readonly string[] = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', 'cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-schema-form',
  '@deepseek-ai/dsh-client-runtime/client',
]

/**
 * Wire/type layers a client bundle may inline: browser-safe contract
 * surfaces with no shared runtime identity. Everything else under
 * @deepseek-ai/* is either a module-table entry (external) or a leak the
 * purity gate rejects.
 *
 * `dsh-tools` was previously listed here, but it is NOT shared-identity-free:
 * it owns module-level `Symbol`s (`TOOL_RUNTIME_SCHEDULER` in code-mode.js)
 * whose identity the host ToolRuntime registry keys on. Inlining it gives the
 * bundle a second, unequal Symbol; the run_code bridge then reads the host
 * registry under the wrong key and crashes with
 * `Cannot read properties of undefined (reading 'prepare')`.
 */
const INLINE_SAFE = /^@deepseek-ai\/dsh-(host-apiproxy|session|llm|brand)(\/|$)/

/** Generated descriptor/codec contribution with no shared runtime identity. */
const GENERATED_REMOTE = /^@deepseek-ai\/dsh-[a-z0-9]+(?:-[a-z0-9]+)*\/remote$/

/**
 * Build the tsdown configs: the node-half lib build plus the browser client
 * bundle. Both halves land in `lib/`; `clean` stays off because the two
 * configs share the output directory.
 * @param id - plugin id (package name), stamped into the __ModuleLoader__.load
 * handoff and onto the injected style tags.
 * @param libEntry - node-half entries (built lib/types/*.js in the dev build,
 * raw src/*.ts in the consumer `prepare` build).
 * @returns the emitted configs.
 */
export function clientBundle(id: string, libEntry: readonly string[]): UserConfig[] {
  return [{
    name: id,
    entry: [...libEntry],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    // `@deepseek-ai/*` modules must stay external in the node half. Bundling
    // them in (dsh-tools in particular) re-instantiates their module-level
    // `Symbol`s, e.g. `TOOL_RUNTIME_SCHEDULER` — a fresh Symbol per bundle.
    // When the plugin then reads the host ToolRuntime registry it looks up a
    // different key than the one the host wrote, gets `undefined`, and any
    // tool dispatch through the run_code bridge crashes with
    // `Cannot read properties of undefined (reading 'prepare')`.
    // The host harness provides these modules, so importing them at runtime
    // shares the exact same Symbol identity.
    external: [/^@deepseek-ai\//],
  }, clientConfig(id)]
}

/** The browser bundle config (shared by the dev and prepare builds). */
function clientConfig(id: string): UserConfig {
  return {
    name: `${id}/client`,
    entry: { client: 'src/client/index.ts' },
    // Browser bundle lands next to the node half (single lib/ artifact
    // dir; the entryFileNames pin keeps it exactly lib/client.js).
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    sourcemap: true,
    clean: false,
    external: [...CLIENT_EXTERNALS],
    // tsdown auto-externalizes package dependencies; anything NOT in the
    // loader module table must inline instead (wire/type layers, qrcode,
    // clsx — every non-shared dep). A require() the table cannot answer is
    // a guaranteed runtime throw, so the rule is the table list itself.
    noExternal: (source: string) => (CLIENT_EXTERNALS.includes(source) ? undefined : true),
    // Browser bundles inline node-idiom deps; the NODE_ENV/import.meta.env
    // substitutions keep their dev-branch semantics from throwing at boot.
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
    },
    plugins: [{
      // Bundle purity gate (mirror of the module-edge rules): platform seed
      // entries stay external, inline-safe wire layers inline, and every
      // other @deepseek-ai value import is a build error. Cross-plugin
      // collaboration goes through cordis services instead. Type-only
      // imports are erased and never reach this gate.
      name: 'dsh-client-bundle-purity',
      resolveId(source: string) {
        if (!source.startsWith('@deepseek-ai/')) return null
        if (CLIENT_EXTERNALS.includes(source)) return null // platform module: external wins
        if (INLINE_SAFE.test(source) || GENERATED_REMOTE.test(source)) return null // wire contribution: inline is the point
        throw new Error(
          `client bundle purity: "${source}" is not a platform module (CLIENT_EXTERNALS), an inline-safe wire layer, or a generated /remote contribution — `
          + 'cross-plugin value imports are forbidden; collaborate through cordis services (type-only imports are erased and never reach this gate)',
        )
      },
    }, {
      name: 'dsh-css-modules-inline',
      resolveId(source: string, importer: string | undefined) {
        if (!source.endsWith('.module.css')) return null
        const abs = importer !== undefined ? sourceAssetPath(source, importer) : source
        return CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
      },
      async load(virtualId: string) {
        if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
        const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
        // The virtual id otherwise hides the physical stylesheet from
        // Rolldown's watch graph.
        this.addWatchFile(fileId)
        const source = await readFile(fileId)
        const { code, exports: cssExports } = transform({
          filename: fileId,
          code: source,
          cssModules: { pattern: '[hash]_[local]' },
          minify: true,
        })
        const classMap: Record<string, string> = {}
        // Sort deterministically: lightningcss's cssExports iteration order
        // is process-dependent, which would churn lib/client.js on rebuilds.
        for (const [local, exp] of Object.entries(cssExports ?? {}).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
          classMap[local] = exp.name
        }
        // One <style data-plugin> per module file; idempotent under re-evaluation.
        return [
          `const css = ${JSON.stringify(code.toString())};`,
          `const tagId = ${JSON.stringify(`${id}/${basename(fileId)}`)};`,
          'if (typeof document !== \'undefined\' && document.querySelector(\'style[data-plugin-css=\' + JSON.stringify(tagId) + \']\') === null) {',
          '  const tag = document.createElement(\'style\');',
          `  tag.dataset.plugin = ${JSON.stringify(id)};`,
          '  tag.dataset.pluginCss = tagId;',
          '  tag.textContent = css;',
          '  document.head.appendChild(tag);',
          '}',
          `export default ${JSON.stringify(classMap)};`,
        ].join('\n')
      },
    }],
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  }
}

/** Resolve an emitted JS asset import against its source-tree counterpart. */
function sourceAssetPath(source: string, importer: string): string {
  const emitted = resolvePath(dirname(importer), source)
  if (existsSync(emitted)) return emitted
  const marker = `${sep}lib${sep}types${sep}`
  const boundary = emitted.indexOf(marker)
  if (boundary < 0) return emitted
  return resolvePath(emitted.slice(0, boundary), 'src', emitted.slice(boundary + marker.length))
}
