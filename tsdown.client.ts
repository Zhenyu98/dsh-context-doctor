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
 * entities, no globals, no import map).
 *
 * The upstream preset also carries a lightningcss CSS Modules pipeline. This
 * plugin styles everything inline and ships no `.module.css`, so that half is
 * left out rather than vendored dead. Add it back from upstream if a
 * stylesheet ever appears.
 */
import type { UserConfig } from 'tsdown'

/**
 * Externals resolved from the loader module table: the shared browser
 * platform modules the shell seeds, mirroring the checkout's
 * `packages/client/web/src/platform.ts` `PLATFORM_MODULES`. Anything else is
 * inlined into the bundle.
 *
 * This list is a hard dependency on one harness generation and must be
 * re-checked on every DSH upgrade. 0.1.2 replaced the `dsh-client-runtime`
 * seed with `dsh-client-store`; a bundle still emitting
 * `require("@deepseek-ai/dsh-client-runtime/client")` gets "missed the module
 * table" and takes the whole web shell down with it, not just this plugin
 * (issues #9 / #13). Tracks DSH 0.1.2-rc.1, verified against master
 * (0.1.3-alpha.1), which seeds the same set.
 */
const CLIENT_EXTERNALS: readonly string[] = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
]

/**
 * Host-half externals: every runtime the harness itself owns. Inlining one of
 * these mints a second copy of a process singleton — a second `ToolRuntime`,
 * a second `TOOL_RUNTIME_SCHEDULER` symbol — and the host's
 * `ctx.tools[TOOL_RUNTIME_SCHEDULER]` lookup then reads `undefined`, taking
 * down tool dispatch mid-turn (issue #2). The harness resolves these from the
 * profile's node_modules, so they stay bare imports in the emitted bundle and
 * must be declared as peerDependencies.
 */
const HOST_EXTERNAL = /^(?:@deepseek-ai\/|cordis(?:\/|$))/

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
    external: [HOST_EXTERNAL],
    plugins: [{
      // Belt to the `external` braces: tsdown only auto-externalizes declared
      // dependencies, and a symlinked dev checkout resolves host packages to
      // absolute paths before the bare id ever reaches the external matcher.
      // Pinning them external at resolve time is what actually holds.
      name: 'dsh-host-bundle-externals',
      resolveId(source: string) {
        return HOST_EXTERNAL.test(source) ? { id: source, external: true } : null
      },
    }],
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
      // Bundle purity gate: a platform seed entry stays external, anything
      // else under @deepseek-ai/ is a build error. Cross-plugin value imports
      // are forbidden — collaborate through cordis services. Type-only imports
      // are erased and never reach this hook, which is why the whole client
      // half can name harness packages freely and still pass.
      name: 'dsh-client-bundle-purity',
      resolveId(source: string) {
        if (!source.startsWith('@deepseek-ai/')) return null
        if (CLIENT_EXTERNALS.includes(source)) return null // platform module: external wins
        throw new Error(
          `client bundle purity: "${source}" is not in the loader module table (CLIENT_EXTERNALS) — `
          + 'cross-plugin value imports are forbidden; collaborate through cordis services '
          + '(type-only imports are erased and never reach this gate)',
        )
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

