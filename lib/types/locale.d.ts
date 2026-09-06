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
export type HostLocaleId = 'zh' | 'en';
/** Settings namespace and field carrying the explicit language choice. */
export declare const LOCALE_SETTINGS_NAMESPACE = "locale";
export declare const LOCALE_PREFERENCE_FIELD = "preference";
/** English catalog; the key set the other catalogs mirror. */
declare const en: {
    readonly sep: ", ";
    readonly 'r.title': "# Context Doctor audit report (cwd: {cwd})";
    readonly 'r.s1': "## 1. Instruction chain (AGENTS.md / CLAUDE.md)";
    readonly 'r.instFiles': "- Injected files: {n}, {tokens} tokens total";
    readonly 'r.instFile': "  - {path} ({tokens} tokens / {bytes})";
    readonly 'r.dupBlocks': "- ⚠ Duplicated blocks across files: {n}";
    readonly 'r.dupBlock': "  - {tokens} tokens × {files} files: {paths}";
    readonly 'r.noDup': "- No duplicated blocks across files";
    readonly 'r.s2': "## 2. Skills catalog (resident in every request)";
    readonly 'r.skills': "- {n} skills, {tokens} tokens of descriptions";
    readonly 'r.skillSource': "  - {source}: {count} skills / {tokens} tokens";
    readonly 'r.bodies': "- Skill bodies (loaded on demand): {n} counted, ~{tokens} tokens";
    readonly 'r.dupDesc': "- ⚠ Identical descriptions: {n} groups";
    readonly 'r.dupDescItem': "  - {count} skills share one description (e.g. \"{name}\")";
    readonly 'r.s3': "## 3. Tool schemas (resident in every request)";
    readonly 'r.tools': "- {n} visible tools, {tokens} tokens of schema ({native} built-in / {nativeTokens} tokens)";
    readonly 'r.mcp': "- MCP: {n} tools / {tokens} tokens";
    readonly 'r.mcpServer': "  - {server}: {tools} tools / {tokens} tokens";
    readonly 'r.s4': "## 4. Same-name skill conflicts (rank shadow)";
    readonly 'r.conflict': "- {name}: {winner} wins; {shadowed} shadowed";
    readonly 'r.s5': "## 5. Suggestions ({n})";
    readonly 'r.noIssues': "- Nothing notable; the current injection surface is healthy.";
    readonly 's.instHeavy': "The instruction chain is heavy ({tokens} tokens). Trim AGENTS.md / CLAUDE.md so each layer keeps only the rules unique to it.";
    readonly 's.dupBlock': "A duplicated block ({tokens} tokens) appears in {n} files: {paths}. Keep one copy and link to it from the rest.";
    readonly 's.skillCatalog': "Skill catalog descriptions cost {tokens} tokens ({n} skills, carried in every request). Shorten the descriptions or install fewer skills.";
    readonly 's.dupSkillDesc': "{n} skills share an identical description (e.g. \"{name}\"). The catalog is paying for it twice — merge them or make the descriptions distinct.";
    readonly 's.skillBodies': "{n} skill bodies counted, ~{tokens} tokens (loaded on demand, not resident in requests).";
    readonly 's.mcpBloat': "The MCP tool surface is large: {n} tools, ~{tokens} tokens of schema. Largest servers: {servers}. Drop the servers or tools you do not need.";
    readonly 's.manyTools': "{n} tools are visible (~{tokens} tokens of schema) and every request carries all of them. Check whether they are all needed.";
    readonly 's.conflict': "Skill \"{name}\" comes from several sources: {winner} wins and {shadowed} are shadowed. The model only ever loads the winner.";
};
/** Message key union. */
export type HostMessageKey = keyof typeof en;
/** Every message key, so a test can assert the catalogs stay in step. */
export declare const HOST_MESSAGE_KEYS: HostMessageKey[];
/** Bound message lookup with `{placeholder}` interpolation. */
export type HostTranslate = (key: HostMessageKey, params?: Record<string, string | number>) => string;
/**
 * Normalize any language tag to a catalog this plugin ships.
 * @param preference - a BCP 47-ish tag (`zh`, `zh-CN`, `en-US`), or anything else.
 * @returns the matching catalog id; English when there is no match.
 */
export declare function resolveHostLocale(preference: unknown): HostLocaleId;
/**
 * Bind a catalog.
 * @param locale - catalog to read; defaults to English.
 * @returns the lookup used by the report renderer and the suggestion builder.
 */
export declare function hostTranslate(locale?: HostLocaleId): HostTranslate;
export {};
