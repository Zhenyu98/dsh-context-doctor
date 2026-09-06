/**
 * Host-half message catalog.
 *
 * Split by audience, which is the whole point of this module (issue #11):
 *
 * - The `context_audit` tool description and its parameter descriptions are
 *   read by the **model**, not by a person. Those stay hard-coded English in
 *   `src/index.ts` — every built-in DSH tool (`tool-skill`, `tool-fs-search`, …)
 *   describes itself in English, and a schema that changes language under the
 *   model is a liability, not a feature.
 * - The rendered report and the suggestion sentences are read by a **person**,
 *   so they follow the harness language and live here.
 *
 * Resolving that language is lossy on the host side and deliberately so. The
 * preference lives in the user settings document under `locale.preference`,
 * but the field is optional and its absence means "follow the browser" — which
 * the host cannot see. So the browser panel passes its own language explicitly
 * (`?lang=`), and the tool path falls back to the stored preference, then to
 * English.
 *
 * @module dsh-context-doctor/locale
 */

/** Languages this plugin ships host-side copy for. */
export type HostLocaleId = 'zh' | 'en'

/** Settings namespace and field carrying the explicit language choice. */
export const LOCALE_SETTINGS_NAMESPACE = 'locale'
export const LOCALE_PREFERENCE_FIELD = 'preference'

/** English catalog; the key set the other catalogs mirror. */
const en = {
  sep: ', ',
  'r.title': '# Context Doctor audit report (cwd: {cwd})',
  'r.s1': '## 1. Instruction chain (AGENTS.md / CLAUDE.md)',
  'r.instFiles': '- Injected files: {n}, {tokens} tokens total',
  'r.instFile': '  - {path} ({tokens} tokens / {bytes})',
  'r.dupBlocks': '- ⚠ Duplicated blocks across files: {n}',
  'r.dupBlock': '  - {tokens} tokens × {files} files: {paths}',
  'r.noDup': '- No duplicated blocks across files',
  'r.s2': '## 2. Skills catalog (resident in every request)',
  'r.skills': '- {n} skills, {tokens} tokens of descriptions',
  'r.skillSource': '  - {source}: {count} skills / {tokens} tokens',
  'r.bodies': '- Skill bodies (loaded on demand): {n} counted, ~{tokens} tokens',
  'r.dupDesc': '- ⚠ Identical descriptions: {n} groups',
  'r.dupDescItem': '  - {count} skills share one description (e.g. "{name}")',
  'r.s3': '## 3. Tool schemas (resident in every request)',
  'r.tools': '- {n} visible tools, {tokens} tokens of schema ({native} built-in / {nativeTokens} tokens)',
  'r.mcp': '- MCP: {n} tools / {tokens} tokens',
  'r.mcpServer': '  - {server}: {tools} tools / {tokens} tokens',
  'r.s4': '## 4. Same-name skill conflicts (rank shadow)',
  'r.conflict': '- {name}: {winner} wins; {shadowed} shadowed',
  'r.s5': '## 5. Suggestions ({n})',
  'r.noIssues': '- Nothing notable; the current injection surface is healthy.',

  's.instHeavy': 'The instruction chain is heavy ({tokens} tokens). Trim AGENTS.md / CLAUDE.md so each layer keeps only the rules unique to it.',
  's.dupBlock': 'A duplicated block ({tokens} tokens) appears in {n} files: {paths}. Keep one copy and link to it from the rest.',
  's.skillCatalog': 'Skill catalog descriptions cost {tokens} tokens ({n} skills, carried in every request). Shorten the descriptions or install fewer skills.',
  's.dupSkillDesc': '{n} skills share an identical description (e.g. "{name}"). The catalog is paying for it twice — merge them or make the descriptions distinct.',
  's.skillBodies': '{n} skill bodies counted, ~{tokens} tokens (loaded on demand, not resident in requests).',
  's.mcpBloat': 'The MCP tool surface is large: {n} tools, ~{tokens} tokens of schema. Largest servers: {servers}. Drop the servers or tools you do not need.',
  's.manyTools': '{n} tools are visible (~{tokens} tokens of schema) and every request carries all of them. Check whether they are all needed.',
  's.conflict': 'Skill "{name}" comes from several sources: {winner} wins and {shadowed} are shadowed. The model only ever loads the winner.',
} as const

/** Message key union. */
export type HostMessageKey = keyof typeof en

/** Every message key, so a test can assert the catalogs stay in step. */
export const HOST_MESSAGE_KEYS = Object.keys(en) as HostMessageKey[]

/** Simplified Chinese catalog; mirrors {@link en} key for key. */
const zh: Record<HostMessageKey, string> = {
  sep: '、',
  'r.title': '# Context Doctor 审计报告（cwd: {cwd}）',
  'r.s1': '## 1. 指令链（AGENTS.md / CLAUDE.md）',
  'r.instFiles': '- 注入文件：{n} 个，共 {tokens} token',
  'r.instFile': '  - {path}（{tokens} token / {bytes}）',
  'r.dupBlocks': '- ⚠ 跨文件重复段落：{n} 处',
  'r.dupBlock': '  - {tokens} token × {files} 文件：{paths}',
  'r.noDup': '- 未发现跨文件重复段落',
  'r.s2': '## 2. 技能目录（catalog，每请求常驻）',
  'r.skills': '- {n} 个技能，摘要共 {tokens} token',
  'r.skillSource': '  - {source}: {count} 个 / {tokens} token',
  'r.bodies': '- 技能正文（按需加载）：已统计 {n} 个，共约 {tokens} token',
  'r.dupDesc': '- ⚠ 描述重复：{n} 组',
  'r.dupDescItem': '  - {count} 个技能共用描述（如「{name}」）',
  'r.s3': '## 3. 工具 schema（每请求常驻）',
  'r.tools': '- 可见工具 {n} 个，schema 共 {tokens} token（其中原生 {native} 个 / {nativeTokens} token）',
  'r.mcp': '- MCP：{n} 个工具 / {tokens} token',
  'r.mcpServer': '  - {server}: {tools} 工具 / {tokens} token',
  'r.s4': '## 4. 同名技能冲突（rank shadow）',
  'r.conflict': '- {name}: {winner} 胜出；{shadowed} 被 shadow',
  'r.s5': '## 5. 建议（{n} 条）',
  'r.noIssues': '- 未发现明显问题，当前注入面健康。',

  's.instHeavy': '指令链总 token 偏高（{tokens}），建议精简 AGENTS.md/CLAUDE.md，只保留每层独有的规则。',
  's.dupBlock': '重复段落（{tokens} token）出现在 {n} 个文件：{paths}。建议只保留一处，其余改为链接。',
  's.skillCatalog': '技能 catalog 摘要占用 {tokens} token（{n} 个技能，每个请求都会携带），建议缩短 description 或减少技能数量。',
  's.dupSkillDesc': '{n} 个技能描述完全相同（如「{name}」），catalog 存在冗余，建议合并或差异化描述。',
  's.skillBodies': '已统计 {n} 个技能正文，共约 {tokens} token（按需加载，不常驻请求）。',
  's.mcpBloat': 'MCP 工具面膨胀：{n} 个工具、schema 约 {tokens} token。最大服务器：{servers}。建议裁剪不需要的服务器或工具。',
  's.manyTools': '可见工具共 {n} 个（schema 约 {tokens} token），每个请求都会携带，建议检查是否全部需要。',
  's.conflict': '技能「{name}」存在多个来源：{winner} 胜出，{shadowed} 被 shadow，模型只会加载胜出者。',
}

const CATALOGS: Record<HostLocaleId, Record<HostMessageKey, string>> = { en, zh }

/** Bound message lookup with `{placeholder}` interpolation. */
export type HostTranslate = (key: HostMessageKey, params?: Record<string, string | number>) => string

/**
 * Normalize any language tag to a catalog this plugin ships.
 * @param preference - a BCP 47-ish tag (`zh`, `zh-CN`, `en-US`), or anything else.
 * @returns the matching catalog id; English when there is no match.
 */
export function resolveHostLocale(preference: unknown): HostLocaleId {
  return typeof preference === 'string' && preference.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

/**
 * Bind a catalog.
 * @param locale - catalog to read; defaults to English.
 * @returns the lookup used by the report renderer and the suggestion builder.
 */
export function hostTranslate(locale: HostLocaleId = 'en'): HostTranslate {
  const catalog = CATALOGS[locale]
  return (key, params) => {
    const template = catalog[key]
    if (params === undefined) return template
    return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
      Object.hasOwn(params, name) ? String(params[name]) : whole)
  }
}
