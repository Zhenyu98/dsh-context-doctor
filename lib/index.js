import { defineTool } from "@deepseek-ai/dsh-tools";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
//#region lib/types/tokens.js
/**
* 启发式 token 估算。
*
* 不依赖外部 tokenizer：英文（ASCII）约 4 字符/token，中文等非 ASCII 约 1.5
* 字符/token。结果用于比较相对成本与趋势，不是精确计数（精确值以模型
* tokenizer 为准）。
*/
function estimateTokens(text) {
	let ascii = 0;
	let nonAscii = 0;
	for (const ch of text) if (ch.codePointAt(0) < 128) ascii++;
	else nonAscii++;
	return Math.ceil(ascii / 4 + nonAscii / 1.5);
}
/**
* 把 token 数格式化为人类可读：1234 -> "1.2k"，50000 -> "50k"。
*
* 浏览器半区也直接引这个函数——本模块无 node 依赖，纯字符串运算。面板此前
* 自带过一份副本，两份漂移后同一个数字在报告里显示 "50.0k"、在面板里 "50k"。
*/
function formatTokens(n) {
	if (n < 1e3) return String(n);
	const k = n / 1e3;
	if (k >= 100 || Number.isInteger(k)) return `${Math.round(k)}k`;
	return `${k.toFixed(1)}k`;
}
/** 把字节数格式化为人类可读。 */
function formatBytes(n) {
	if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
	if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${n} B`;
}
//#endregion
//#region lib/types/analyze.js
/**
* 重复 / 冲突检测的纯函数集合。不依赖任何 DSH 运行时，可独立测试。
*/
/** 把文本切成"连续非空行"块（空行是分块边界）。 */
function splitBlocks(content) {
	const lines = content.split(/\r?\n/);
	const blocks = [];
	let current = [];
	const flush = () => {
		if (current.length > 0) {
			blocks.push(current.join("\n"));
			current = [];
		}
	};
	for (const line of lines) if (line.trim() === "") flush();
	else current.push(line);
	flush();
	return blocks;
}
/**
* 跨文件完全相同的段落块检测。
* @param files - 待比较的文件列表
* @param minLen - 小于该长度的块不参与（避免噪音）
* @returns 按 token 数降序的重复块
*/
function findDuplicateBlocks(files, minLen = 40) {
	const buckets = /* @__PURE__ */ new Map();
	for (const file of files) {
		const seen = /* @__PURE__ */ new Set();
		for (const block of splitBlocks(file.content)) {
			if (block.length < minLen || seen.has(block)) continue;
			seen.add(block);
			const list = buckets.get(block);
			if (list !== void 0) list.push(file.path);
			else buckets.set(block, [file.path]);
		}
	}
	const out = [];
	for (const [text, paths] of buckets) if (paths.length >= 2) out.push({
		text,
		tokens: estimateTokens(text),
		paths: [...paths].sort()
	});
	return out.sort((a, b) => b.tokens - a.tokens);
}
function findRankShadows(skills) {
	const byName = /* @__PURE__ */ new Map();
	for (const skill of skills) {
		const list = byName.get(skill.name);
		if (list !== void 0) list.push(skill);
		else byName.set(skill.name, [skill]);
	}
	const out = [];
	for (const [name, list] of byName) {
		if (list.length < 2) continue;
		const sorted = [...list].sort((a, b) => a.rank - b.rank || a.provider.localeCompare(b.provider));
		const winner = sorted[0];
		if (winner === void 0) continue;
		out.push({
			name,
			winner: {
				source: winner.source,
				provider: winner.provider
			},
			shadowed: sorted.slice(1).map((s) => ({
				source: s.source,
				provider: s.provider
			}))
		});
	}
	return out.sort((a, b) => a.name.localeCompare(b.name));
}
function groupMcpTools(schemas) {
	const byServer = /* @__PURE__ */ new Map();
	for (const schema of schemas) {
		if (!schema.name.startsWith("mcp__")) continue;
		const server = schema.name.split("__")[1] ?? "unknown";
		const cur = byServer.get(server) ?? {
			tools: 0,
			tokens: 0
		};
		cur.tools++;
		cur.tokens += estimateTokens(schema.name) + estimateTokens(schema.description ?? "");
		byServer.set(server, cur);
	}
	const servers = [...byServer.entries()].map(([server, v]) => ({
		server,
		tools: v.tools,
		schemaTokens: v.tokens
	})).sort((a, b) => b.schemaTokens - a.schemaTokens);
	return {
		servers,
		totalTools: servers.reduce((acc, s) => acc + s.tools, 0),
		totalTokens: servers.reduce((acc, s) => acc + s.schemaTokens, 0)
	};
}
//#endregion
//#region lib/types/locale.js
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
/** Settings namespace and field carrying the explicit language choice. */
const LOCALE_SETTINGS_NAMESPACE = "locale";
const LOCALE_PREFERENCE_FIELD = "preference";
const CATALOGS = {
	en: {
		sep: ", ",
		"r.title": "# Context Doctor audit report (cwd: {cwd})",
		"r.s1": "## 1. Instruction chain (AGENTS.md / CLAUDE.md)",
		"r.instFiles": "- Injected files: {n}, {tokens} tokens total",
		"r.instFile": "  - {path} ({tokens} tokens / {bytes})",
		"r.dupBlocks": "- ⚠ Duplicated blocks across files: {n}",
		"r.dupBlock": "  - {tokens} tokens × {files} files: {paths}",
		"r.noDup": "- No duplicated blocks across files",
		"r.s2": "## 2. Skills catalog (resident in every request)",
		"r.skills": "- {n} skills, {tokens} tokens of descriptions",
		"r.skillSource": "  - {source}: {count} skills / {tokens} tokens",
		"r.bodies": "- Skill bodies (loaded on demand): {n} counted, ~{tokens} tokens",
		"r.dupDesc": "- ⚠ Identical descriptions: {n} groups",
		"r.dupDescItem": "  - {count} skills share one description (e.g. \"{name}\")",
		"r.s3": "## 3. Tool schemas (resident in every request)",
		"r.tools": "- {n} visible tools, {tokens} tokens of schema ({native} built-in / {nativeTokens} tokens)",
		"r.mcp": "- MCP: {n} tools / {tokens} tokens",
		"r.mcpServer": "  - {server}: {tools} tools / {tokens} tokens",
		"r.s4": "## 4. Same-name skill conflicts (rank shadow)",
		"r.conflict": "- {name}: {winner} wins; {shadowed} shadowed",
		"r.s5": "## 5. Suggestions ({n})",
		"r.noIssues": "- Nothing notable; the current injection surface is healthy.",
		"s.instHeavy": "The instruction chain is heavy ({tokens} tokens). Trim AGENTS.md / CLAUDE.md so each layer keeps only the rules unique to it.",
		"s.dupBlock": "A duplicated block ({tokens} tokens) appears in {n} files: {paths}. Keep one copy and link to it from the rest.",
		"s.skillCatalog": "Skill catalog descriptions cost {tokens} tokens ({n} skills, carried in every request). Shorten the descriptions or install fewer skills.",
		"s.dupSkillDesc": "{n} skills share an identical description (e.g. \"{name}\"). The catalog is paying for it twice — merge them or make the descriptions distinct.",
		"s.skillBodies": "{n} skill bodies counted, ~{tokens} tokens (loaded on demand, not resident in requests).",
		"s.mcpBloat": "The MCP tool surface is large: {n} tools, ~{tokens} tokens of schema. Largest servers: {servers}. Drop the servers or tools you do not need.",
		"s.manyTools": "{n} tools are visible (~{tokens} tokens of schema) and every request carries all of them. Check whether they are all needed.",
		"s.conflict": "Skill \"{name}\" comes from several sources: {winner} wins and {shadowed} are shadowed. The model only ever loads the winner."
	},
	zh: {
		sep: "、",
		"r.title": "# Context Doctor 审计报告（cwd: {cwd}）",
		"r.s1": "## 1. 指令链（AGENTS.md / CLAUDE.md）",
		"r.instFiles": "- 注入文件：{n} 个，共 {tokens} token",
		"r.instFile": "  - {path}（{tokens} token / {bytes}）",
		"r.dupBlocks": "- ⚠ 跨文件重复段落：{n} 处",
		"r.dupBlock": "  - {tokens} token × {files} 文件：{paths}",
		"r.noDup": "- 未发现跨文件重复段落",
		"r.s2": "## 2. 技能目录（catalog，每请求常驻）",
		"r.skills": "- {n} 个技能，摘要共 {tokens} token",
		"r.skillSource": "  - {source}: {count} 个 / {tokens} token",
		"r.bodies": "- 技能正文（按需加载）：已统计 {n} 个，共约 {tokens} token",
		"r.dupDesc": "- ⚠ 描述重复：{n} 组",
		"r.dupDescItem": "  - {count} 个技能共用描述（如「{name}」）",
		"r.s3": "## 3. 工具 schema（每请求常驻）",
		"r.tools": "- 可见工具 {n} 个，schema 共 {tokens} token（其中原生 {native} 个 / {nativeTokens} token）",
		"r.mcp": "- MCP：{n} 个工具 / {tokens} token",
		"r.mcpServer": "  - {server}: {tools} 工具 / {tokens} token",
		"r.s4": "## 4. 同名技能冲突（rank shadow）",
		"r.conflict": "- {name}: {winner} 胜出；{shadowed} 被 shadow",
		"r.s5": "## 5. 建议（{n} 条）",
		"r.noIssues": "- 未发现明显问题，当前注入面健康。",
		"s.instHeavy": "指令链总 token 偏高（{tokens}），建议精简 AGENTS.md/CLAUDE.md，只保留每层独有的规则。",
		"s.dupBlock": "重复段落（{tokens} token）出现在 {n} 个文件：{paths}。建议只保留一处，其余改为链接。",
		"s.skillCatalog": "技能 catalog 摘要占用 {tokens} token（{n} 个技能，每个请求都会携带），建议缩短 description 或减少技能数量。",
		"s.dupSkillDesc": "{n} 个技能描述完全相同（如「{name}」），catalog 存在冗余，建议合并或差异化描述。",
		"s.skillBodies": "已统计 {n} 个技能正文，共约 {tokens} token（按需加载，不常驻请求）。",
		"s.mcpBloat": "MCP 工具面膨胀：{n} 个工具、schema 约 {tokens} token。最大服务器：{servers}。建议裁剪不需要的服务器或工具。",
		"s.manyTools": "可见工具共 {n} 个（schema 约 {tokens} token），每个请求都会携带，建议检查是否全部需要。",
		"s.conflict": "技能「{name}」存在多个来源：{winner} 胜出，{shadowed} 被 shadow，模型只会加载胜出者。"
	}
};
/**
* Normalize any language tag to a catalog this plugin ships.
* @param preference - a BCP 47-ish tag (`zh`, `zh-CN`, `en-US`), or anything else.
* @returns the matching catalog id; English when there is no match.
*/
function resolveHostLocale(preference) {
	return typeof preference === "string" && preference.toLowerCase().startsWith("zh") ? "zh" : "en";
}
/**
* Bind a catalog.
* @param locale - catalog to read; defaults to English.
* @returns the lookup used by the report renderer and the suggestion builder.
*/
function hostTranslate(locale = "en") {
	const catalog = CATALOGS[locale];
	return (key, params) => {
		const template = catalog[key];
		if (params === void 0) return template;
		return template.replace(/\{(\w+)\}/g, (whole, name) => Object.hasOwn(params, name) ? String(params[name]) : whole);
	};
}
/** 指令链文件名（DSH 注入的 workspace instruction 文件）。 */
const INSTRUCTION_NAMES = ["AGENTS.md", "CLAUDE.md"];
async function pathExists(fs, path, signal) {
	try {
		const target = await fs.resolve(path, { signal });
		return await fs.stat(target, signal) !== void 0;
	} catch {
		return false;
	}
}
/**
* 从 cwd 向上找到 git 根（含 .git 的最高目录）；从根到 cwd 的每一层收集
* AGENTS.md / CLAUDE.md，与 DSH 的 workspace instruction 注入链对齐。
*/
async function scanInstructionChain(fs, cwd, signal) {
	let root = cwd;
	let current = cwd;
	for (;;) {
		if (await pathExists(fs, join(current, ".git"), signal)) {
			root = current;
			break;
		}
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	const layers = [];
	current = cwd;
	for (;;) {
		layers.push(current);
		if (current === root) break;
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	layers.reverse();
	const rawFiles = [];
	const seenPaths = /* @__PURE__ */ new Set();
	for (const dir of layers) for (const name of INSTRUCTION_NAMES) {
		const fullPath = join(dir, name);
		let target;
		try {
			target = await fs.resolve(fullPath, { signal });
		} catch {
			continue;
		}
		const realPath = fs.processPath(target);
		if (seenPaths.has(realPath)) continue;
		let info;
		try {
			info = await fs.stat(target, signal);
		} catch {
			continue;
		}
		if (info === void 0 || info.type !== "file") continue;
		if (info.size !== void 0 && info.size > 262144) continue;
		let text;
		try {
			text = await fs.readText(target, signal);
		} catch {
			continue;
		}
		if (rawFiles.some((file) => file.content === text)) {
			seenPaths.add(realPath);
			continue;
		}
		seenPaths.add(realPath);
		rawFiles.push({
			path: realPath,
			bytes: info.size ?? Buffer.byteLength(text),
			tokens: estimateTokens(text),
			content: text
		});
	}
	const totalTokens = rawFiles.reduce((acc, f) => acc + f.tokens, 0);
	const duplicateBlocks = findDuplicateBlocks(rawFiles.map((f) => ({
		path: f.path,
		content: f.content
	})));
	return {
		root,
		files: rawFiles.map(({ content: _content, ...rest }) => rest),
		totalTokens,
		duplicateBlocks
	};
}
async function scanSkillCatalog(skillList, signal) {
	const bySource = /* @__PURE__ */ new Map();
	let total = 0;
	for (const skill of skillList) {
		const tokens = estimateTokens(skill.description);
		total += tokens;
		const cur = bySource.get(skill.source) ?? {
			count: 0,
			descriptionTokens: 0
		};
		cur.count++;
		cur.descriptionTokens += tokens;
		bySource.set(skill.source, cur);
	}
	return {
		count: skillList.length,
		totalDescriptionTokens: total,
		bySource: [...bySource.entries()].map(([source, v]) => ({
			source,
			...v
		})).sort((a, b) => b.descriptionTokens - a.descriptionTokens),
		duplicateDescriptions: skillList.map((s) => ({
			name: s.name,
			description: s.description
		})).filter((s) => s.description !== "").reduce((acc, s) => {
			const key = s.description.trim().toLowerCase().replace(/\s+/g, " ");
			const hit = acc.find((h) => h.description.trim().toLowerCase().replace(/\s+/g, " ") === key);
			if (hit !== void 0) hit.count++;
			else acc.push({
				...s,
				count: 1
			});
			return acc;
		}, []).filter((h) => h.count >= 2).sort((a, b) => b.count - a.count)
	};
}
async function scanToolSchemas(tools, agent, signal) {
	let schemas = [];
	try {
		schemas = tools.schemas(agent);
	} catch {
		try {
			schemas = tools.schemas();
		} catch {
			schemas = [];
		}
	}
	let schemaTokens = 0;
	let nativeCount = 0;
	let nativeTokens = 0;
	const items = [];
	const mcpDuplicates = /* @__PURE__ */ new Map();
	for (const schema of schemas) {
		const serialised = stableJson(schema);
		const bytes = new TextEncoder().encode(serialised).byteLength;
		const tokens = estimateTokens(schema.name) + estimateTokens(schema.description ?? "");
		const server = schema.name.startsWith("mcp__") ? schema.name.split("__")[1] ?? "unknown" : void 0;
		const schemaHash = hashSchema(schema.name.startsWith("mcp__") ? stableJson({
			description: schema.description ?? "",
			parameters: schema.parameters ?? null
		}) : serialised);
		items.push({
			name: schema.name,
			bytes,
			tokens,
			schemaHash,
			...server !== void 0 ? { server } : {}
		});
		if (server !== void 0) {
			const duplicate = mcpDuplicates.get(schemaHash) ?? [];
			duplicate.push({
				name: schema.name,
				server,
				bytes
			});
			mcpDuplicates.set(schemaHash, duplicate);
		}
		schemaTokens += tokens;
		if (schema.name.startsWith("mcp__")) continue;
		nativeCount++;
		nativeTokens += tokens;
	}
	const mcp = groupMcpTools(schemas);
	return {
		visibleCount: schemas.length,
		schemaTokens,
		nativeCount,
		nativeTokens,
		mcp,
		items,
		mcpDuplicates
	};
}
function stableJson(value) {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const record = value;
		return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
	}
	return JSON.stringify(value);
}
function hashSchema(value) {
	let hash = 2166136261;
	for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
	return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}
//#endregion
//#region lib/types/audit.js
/** 执行一次完整审计。 */
async function runAudit(deps, options) {
	const { fs, skills, tools } = deps;
	const { cwd, signal } = options;
	const skillLookup = {
		cwd,
		signal,
		...typeof options.agent === "object" && options.agent !== null ? { scope: options.agent } : {}
	};
	const skillList = await skills.list(skillLookup);
	const [instructions, skillCatalog, toolSchemas] = await Promise.all([
		scanInstructionChain(fs, cwd, signal),
		scanSkillCatalog(skillList, signal),
		scanToolSchemas(tools, options.agent, signal)
	]);
	let bodies;
	if (options.includeSkillBodies === true) {
		const max = Math.max(1, Math.min(options.maxSkillBodies ?? 20, 100));
		let count = 0;
		let totalTokens = 0;
		for (const summary of skillList.slice(0, max)) try {
			const def = await skills.get(summary.name, skillLookup);
			if (def !== void 0) {
				count++;
				totalTokens += estimateTokens(def.content);
			}
		} catch {}
		bodies = {
			count,
			totalTokens
		};
	}
	const conflicts = findRankShadows(skillList.map((s) => ({
		name: s.name,
		source: s.source,
		provider: s.provider,
		rank: rankOfSource(s.source)
	})));
	const suggestions = buildSuggestions({
		instructions,
		skills: {
			...skillCatalog,
			...bodies !== void 0 ? { bodies } : {}
		},
		tools: toolSchemas,
		conflicts
	}, options.locale ?? "en");
	const report = {
		tool: "context_audit",
		version: 1,
		cwd,
		injected: {
			instructions: {
				root: instructions.root,
				files: instructions.files,
				totalTokens: instructions.totalTokens,
				duplicateBlocks: instructions.duplicateBlocks.map((b) => ({
					tokens: b.tokens,
					paths: b.paths
				}))
			},
			skills: {
				catalogCount: skillCatalog.count,
				catalogDescriptionTokens: skillCatalog.totalDescriptionTokens,
				bySource: skillCatalog.bySource,
				duplicateDescriptions: skillCatalog.duplicateDescriptions,
				...bodies !== void 0 ? { bodies } : {}
			},
			tools: {
				visibleCount: toolSchemas.visibleCount,
				schemaTokens: toolSchemas.schemaTokens,
				nativeCount: toolSchemas.nativeCount,
				nativeTokens: toolSchemas.nativeTokens,
				mcp: toolSchemas.mcp
			}
		},
		conflicts,
		suggestions
	};
	if (options.detail === "developer") report.receipt = buildDeveloperReceipt({
		instructions,
		skillList,
		toolSchemas,
		conflicts,
		suggestions
	});
	return report;
}
function byteLength(value) {
	return new TextEncoder().encode(value).byteLength;
}
function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}
function preview(value, max = 160) {
	const compact = value.replace(/\s+/g, " ").trim();
	return compact.length <= max ? compact : `${compact.slice(0, max - 1)}…`;
}
function buildDeveloperReceipt(input) {
	const agentsFiles = input.instructions.files.map((file, index) => ({
		...file,
		loadOrder: index + 1,
		duplicateBlocks: input.instructions.duplicateBlocks.filter((block) => block.paths.includes(file.path)).map((block) => ({
			sha256: sha256(block.text),
			tokens: block.tokens,
			paths: block.paths,
			preview: preview(block.text)
		}))
	}));
	const skills = input.skillList.map((skill) => ({
		name: skill.name,
		source: skill.source,
		provider: skill.provider,
		descriptionBytes: byteLength(skill.description),
		descriptionTokens: estimateTokens(skill.description),
		catalogInjected: true
	}));
	const schemaItems = input.toolSchemas.items.map((item) => ({
		name: item.name,
		bytes: item.bytes,
		tokens: item.tokens,
		schemaHash: item.schemaHash,
		...item.server !== void 0 ? { server: item.server } : {}
	}));
	const duplicateMcpEntries = [...input.toolSchemas.mcpDuplicates.entries()].filter(([, items]) => items.length > 1).map(([schemaHash, items]) => ({
		schemaHash,
		names: items.map((item) => item.name).sort(),
		servers: [...new Set(items.map((item) => item.server))].sort(),
		bytes: items.reduce((total, item) => total + item.bytes, 0)
	})).sort((a, b) => b.bytes - a.bytes || a.schemaHash.localeCompare(b.schemaHash));
	return {
		kind: "context-audit-receipt",
		version: 1,
		detail: "developer",
		agentsFiles,
		skills,
		toolSchemas: {
			totalBytes: schemaItems.reduce((total, item) => total + item.bytes, 0),
			items: schemaItems
		},
		duplicateMcpEntries,
		shadowedSkills: input.conflicts,
		trimmed: {
			status: "unavailable",
			items: []
		},
		repairPlan: input.suggestions
	};
}
/** SkillSummary 的 rank 不在公开类型里；按来源给启发式排序值（与官方 rank 语义一致：低者胜）。 */
function rankOfSource(source) {
	switch (source) {
		case "project-dsh": return 100;
		case "project-agents": return 200;
		case "runtime": return 250;
		case "user-dsh": return 300;
		case "user-agents": return 400;
		case "custom": return 500;
		case "bundled": return 600;
		default: return 900;
	}
}
/** 按严重度排序的裁剪建议。 */
function buildSuggestions(input, locale = "en") {
	const t = hostTranslate(locale);
	const sep = t("sep");
	const out = [];
	if (input.instructions.totalTokens > 8e3) out.push({
		severity: "high",
		text: t("s.instHeavy", { tokens: formatTokens(input.instructions.totalTokens) })
	});
	for (const block of input.instructions.duplicateBlocks.slice(0, 5)) out.push({
		severity: "medium",
		text: t("s.dupBlock", {
			tokens: formatTokens(block.tokens),
			n: block.paths.length,
			paths: block.paths.join(sep)
		})
	});
	if (input.skills.totalDescriptionTokens > 3e3) out.push({
		severity: "medium",
		text: t("s.skillCatalog", {
			tokens: formatTokens(input.skills.totalDescriptionTokens),
			n: input.skills.count
		})
	});
	for (const dup of input.skills.duplicateDescriptions.slice(0, 5)) out.push({
		severity: "medium",
		text: t("s.dupSkillDesc", {
			n: dup.count,
			name: dup.name
		})
	});
	if (input.skills.bodies !== void 0 && input.skills.bodies.totalTokens > 2e4) out.push({
		severity: "low",
		text: t("s.skillBodies", {
			n: input.skills.bodies.count,
			tokens: formatTokens(input.skills.bodies.totalTokens)
		})
	});
	if (input.tools.mcp.totalTokens > 4e3 || input.tools.mcp.totalTools > 20) out.push({
		severity: "high",
		text: t("s.mcpBloat", {
			n: input.tools.mcp.totalTools,
			tokens: formatTokens(input.tools.mcp.totalTokens),
			servers: input.tools.mcp.servers.slice(0, 3).map((s) => `${s.server}(${s.tools})`).join(sep)
		})
	});
	if (input.tools.visibleCount > 40) out.push({
		severity: "low",
		text: t("s.manyTools", {
			n: input.tools.visibleCount,
			tokens: formatTokens(input.tools.schemaTokens)
		})
	});
	for (const conflict of input.conflicts.slice(0, 5)) out.push({
		severity: "medium",
		text: t("s.conflict", {
			name: conflict.name,
			winner: `${conflict.winner.source}(${conflict.winner.provider})`,
			shadowed: conflict.shadowed.map((s) => `${s.source}(${s.provider})`).join(sep)
		})
	});
	return out;
}
/** 把 canonical 报告渲染成模型可读文本。 */
function renderReport(report, locale = "en") {
	const t = hostTranslate(locale);
	const sep = t("sep");
	const lines = [];
	lines.push(t("r.title", { cwd: report.cwd }));
	lines.push("");
	const inst = report.injected.instructions;
	lines.push(t("r.s1"));
	lines.push(t("r.instFiles", {
		n: inst.files.length,
		tokens: formatTokens(inst.totalTokens)
	}));
	for (const f of inst.files) lines.push(t("r.instFile", {
		path: f.path,
		tokens: formatTokens(f.tokens),
		bytes: formatBytes(f.bytes)
	}));
	if (inst.duplicateBlocks.length > 0) {
		lines.push(t("r.dupBlocks", { n: inst.duplicateBlocks.length }));
		for (const b of inst.duplicateBlocks.slice(0, 5)) lines.push(t("r.dupBlock", {
			tokens: formatTokens(b.tokens),
			files: b.paths.length,
			paths: b.paths.join(sep)
		}));
	} else lines.push(t("r.noDup"));
	lines.push("");
	const sk = report.injected.skills;
	lines.push(t("r.s2"));
	lines.push(t("r.skills", {
		n: sk.catalogCount,
		tokens: formatTokens(sk.catalogDescriptionTokens)
	}));
	for (const s of sk.bySource) lines.push(t("r.skillSource", {
		source: s.source,
		count: s.count,
		tokens: formatTokens(s.descriptionTokens)
	}));
	if (sk.bodies !== void 0) lines.push(t("r.bodies", {
		n: sk.bodies.count,
		tokens: formatTokens(sk.bodies.totalTokens)
	}));
	if (sk.duplicateDescriptions.length > 0) {
		lines.push(t("r.dupDesc", { n: sk.duplicateDescriptions.length }));
		for (const d of sk.duplicateDescriptions.slice(0, 5)) lines.push(t("r.dupDescItem", {
			count: d.count,
			name: d.name
		}));
	}
	lines.push("");
	const tl = report.injected.tools;
	lines.push(t("r.s3"));
	lines.push(t("r.tools", {
		n: tl.visibleCount,
		tokens: formatTokens(tl.schemaTokens),
		native: tl.nativeCount,
		nativeTokens: formatTokens(tl.nativeTokens)
	}));
	if (tl.mcp.totalTools > 0) {
		lines.push(t("r.mcp", {
			n: tl.mcp.totalTools,
			tokens: formatTokens(tl.mcp.totalTokens)
		}));
		for (const s of tl.mcp.servers) lines.push(t("r.mcpServer", {
			server: s.server,
			tools: s.tools,
			tokens: formatTokens(s.schemaTokens)
		}));
	}
	lines.push("");
	if (report.conflicts.length > 0) {
		lines.push(t("r.s4"));
		for (const c of report.conflicts) lines.push(t("r.conflict", {
			name: c.name,
			winner: `${c.winner.source}(${c.winner.provider})`,
			shadowed: c.shadowed.map((s) => `${s.source}(${s.provider})`).join(sep)
		}));
		lines.push("");
	}
	lines.push(t("r.s5", { n: report.suggestions.length }));
	if (report.suggestions.length === 0) lines.push(t("r.noIssues"));
	for (const s of report.suggestions) lines.push(`- [${s.severity}] ${s.text}`);
	if (report.receipt !== void 0) {
		const receipt = report.receipt;
		lines.push("");
		lines.push("## Developer context-audit receipt");
		lines.push(`- AGENTS files: ${receipt.agentsFiles.length}`);
		for (const file of receipt.agentsFiles) {
			lines.push(`  - #${file.loadOrder} ${file.path}: ${formatBytes(file.bytes)} / ${formatTokens(file.tokens)} token`);
			for (const duplicate of file.duplicateBlocks) lines.push(`    - duplicate ${duplicate.sha256.slice(0, 12)}… (${formatTokens(duplicate.tokens)} token): ${duplicate.preview}`);
		}
		lines.push(`- Catalog-injected skills: ${receipt.skills.length}`);
		for (const skill of receipt.skills) lines.push(`  - ${skill.name} [${skill.source}/${skill.provider}]: ${formatBytes(skill.descriptionBytes)} / ${formatTokens(skill.descriptionTokens)} token`);
		lines.push(`- Tool schemas: ${formatBytes(receipt.toolSchemas.totalBytes)} serialized across ${receipt.toolSchemas.items.length} tools`);
		for (const duplicate of receipt.duplicateMcpEntries) lines.push(`  - duplicate MCP signature ${duplicate.schemaHash}: ${duplicate.names.join("、")} (${formatBytes(duplicate.bytes)})`);
		lines.push(`- Shadowed skills: ${receipt.shadowedSkills.length}`);
		lines.push(`- Trimmed entries: ${receipt.trimmed.status} (DSH assembly trace is not exposed)`);
	}
	return lines.join("\n");
}
//#endregion
//#region lib/types/routes.js
/** 浏览器侧 API 前缀。 */
const AUDIT_API_PREFIX = "/api/context-doctor";
/** 写 JSON 响应。 */
function json(res, status, body) {
	res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(body));
}
/** 从查询字符串取单个参数（URL 解码；重复取首个）。 */
function parseQueryParam(url, key) {
	const query = url.includes("?") ? url.slice(url.indexOf("?") + 1) : "";
	for (const part of query.split("&")) {
		if (!part.startsWith(`${key}=`)) continue;
		try {
			return decodeURIComponent(part.slice(key.length + 1));
		} catch {
			return;
		}
	}
}
/** 解析审计起点目录：显式 cwd > 会话 cwd > defaultCwd > 进程 cwd。 */
function resolveCwd(url, config) {
	const explicit = parseQueryParam(url, "cwd");
	if (explicit !== void 0 && explicit !== "") return explicit;
	const sessionId = parseQueryParam(url, "session");
	if (sessionId !== void 0 && sessionId !== "") {
		const session = config.sessions?.get(sessionId);
		if (session?.header.cwd !== void 0 && session.header.cwd !== "") return session.header.cwd;
	}
	return config.defaultCwd ?? process.cwd();
}
/** 构造审计路由（含 60s 缓存与 in-flight 复用）。 */
function makeAuditRoutes(config) {
	const { deps, cacheTtlMs = 6e4 } = config;
	const cache = /* @__PURE__ */ new Map();
	/** 缓存条目上限：防止不同 cwd 参数让缓存无限增长（超限时淘汰最旧条目）。 */
	const MAX_CACHE_ENTRIES = 32;
	const audit = (cwd, detail, agent, sessionId, locale) => {
		const key = `${detail} ${locale} ${sessionId} ${cwd}`;
		const hit = cache.get(key);
		if (hit !== void 0 && Date.now() - hit.at < cacheTtlMs) return hit.promise;
		if (cache.size >= MAX_CACHE_ENTRIES) {
			const oldest = cache.keys().next().value;
			if (oldest !== void 0) cache.delete(oldest);
		}
		const promise = runAudit(deps, {
			cwd,
			detail,
			locale,
			signal: new AbortController().signal,
			...agent !== void 0 ? { agent } : {}
		}).catch((error) => {
			cache.delete(key);
			throw error;
		});
		cache.set(key, {
			at: Date.now(),
			promise
		});
		return promise;
	};
	return [{
		kind: "exact",
		path: `${AUDIT_API_PREFIX}/audit`,
		handler: (req, res) => {
			if (req.method !== "GET") {
				json(res, 405, {
					ok: false,
					error: "method-not-allowed"
				});
				return;
			}
			const url = req.url ?? "";
			const cwd = resolveCwd(url, config);
			const detail = parseQueryParam(url, "detail") === "developer" ? "developer" : "summary";
			const sessionId = parseQueryParam(url, "session") ?? "";
			audit(cwd, detail, sessionId === "" ? void 0 : config.agents?.get(sessionId), sessionId, resolveHostLocale(parseQueryParam(url, "lang"))).then((report) => json(res, 200, {
				ok: true,
				report
			}), (error) => json(res, 500, {
				ok: false,
				error: error instanceof Error ? error.message : String(error)
			}));
		}
	}];
}
//#endregion
//#region lib/types/index.js
const name = "context-doctor";
const inject = [
	"fs",
	"skills",
	"tools",
	"sessions"
];
function apply(ctx, config = {}) {
	const deps = {
		fs: ctx.fs,
		skills: ctx.skills,
		tools: ctx.tools
	};
	/**
	* 报告语言（issue #11）。宿主把显式选择存在 settings 的 `locale.preference`，
	* 但该字段可缺省，缺省即「跟随浏览器」——host 看不见浏览器，只能回退英文。
	* 浏览器面板不受这个限制：它在请求里显式带上自己的语言（见 routes.ts）。
	*/
	const reportLocale = () => {
		const section = ctx.get("settings")?.get(LOCALE_SETTINGS_NAMESPACE);
		return resolveHostLocale(section?.[LOCALE_PREFERENCE_FIELD]);
	};
	ctx.tools.register(defineTool({
		name: "context_audit",
		description: "Audit what this session injects into every model request: the AGENTS.md / CLAUDE.md instruction chain, the skills catalog, tool schemas, and MCP tools. Estimates the token cost of each, detects blocks duplicated across files, skills sharing one description, same-name skills shadowing each other, and MCP tool-surface bloat, then returns trimming suggestions ordered by severity. Read-only: it never modifies a file.",
		parameters: {
			cwd: {
				type: "string",
				description: "Directory to audit from. Defaults to the current session workspace."
			},
			includeSkillBodies: {
				type: "boolean",
				description: "Also total the tokens of skill bodies. Loads each body, so it is slower. Defaults to false."
			},
			maxSkillBodies: {
				type: "number",
				description: "How many skill bodies to count when includeSkillBodies is set. Defaults to 20."
			},
			detail: {
				type: "string",
				enum: ["summary", "developer"],
				description: "Output level: \"summary\" for the digest, \"developer\" to also attach a per-entry context-audit receipt."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true
			},
			render: (_args, value) => [{
				type: "text",
				text: renderReport(value, reportLocale())
			}]
		},
		async execute(args, exec) {
			const agentCwd = exec.agent?.session?.header?.cwd;
			return await runAudit(deps, {
				cwd: args.cwd ?? agentCwd ?? config.defaultCwd ?? process.cwd(),
				signal: exec.signal,
				...args.includeSkillBodies !== void 0 ? { includeSkillBodies: args.includeSkillBodies } : {},
				...args.maxSkillBodies !== void 0 ? { maxSkillBodies: args.maxSkillBodies } : {},
				...args.detail === "developer" ? { detail: "developer" } : {},
				...exec.agent !== void 0 ? { agent: exec.agent } : {},
				locale: reportLocale()
			});
		}
	}));
	const sessions = ctx.get("sessions");
	const agents = ctx.get("agents");
	const routes = makeAuditRoutes({
		deps,
		...sessions !== void 0 ? { sessions } : {},
		...agents !== void 0 ? { agents } : {},
		...config.defaultCwd !== void 0 ? { defaultCwd: config.defaultCwd } : {},
		...config.cacheTtlMs !== void 0 ? { cacheTtlMs: config.cacheTtlMs } : {}
	});
	ctx.inject(["webServer"], (httpCtx) => {
		httpCtx.effect(() => {
			const disposers = routes.map((route) => httpCtx.webServer.register(route));
			return () => {
				for (const dispose of disposers) dispose();
			};
		}, "context-doctor: routes");
	});
}
//#endregion
export { apply, inject, name };
