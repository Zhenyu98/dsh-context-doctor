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
/** 把 token 数格式化为人类可读：1234 -> "1.2k" */
function formatTokens(n) {
	if (n >= 1e3) {
		const k = n / 1e3;
		return `${k >= 100 ? Math.round(k) : k.toFixed(1)}k`;
	}
	return String(n);
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
	for (const dir of layers) for (const name of INSTRUCTION_NAMES) {
		const fullPath = join(dir, name);
		let target;
		try {
			target = await fs.resolve(fullPath, { signal });
		} catch {
			continue;
		}
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
		rawFiles.push({
			path: fs.processPath(target),
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
	const skillList = await skills.list({
		cwd,
		signal
	});
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
			const def = await skills.get(summary.name, {
				cwd,
				signal
			});
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
	});
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
function buildSuggestions(input) {
	const out = [];
	if (input.instructions.totalTokens > 8e3) out.push({
		severity: "high",
		text: `Instruction chain tokens are high (${formatTokens(input.instructions.totalTokens)}); consider trimming AGENTS.md/CLAUDE.md to keep only rules unique to each layer.`
	});
	for (const block of input.instructions.duplicateBlocks.slice(0, 5)) out.push({
		severity: "medium",
		text: `Duplicate block (${formatTokens(block.tokens)} tokens) appears in ${block.paths.length} files: ${block.paths.join(', ')}. Keep one copy and turn the others into links.`
	});
	if (input.skills.totalDescriptionTokens > 3e3) out.push({
		severity: "medium",
		text: `Skill catalog descriptions take ${formatTokens(input.skills.totalDescriptionTokens)} tokens (${input.skills.count} skills, carried on every request); consider shortening descriptions or reducing the number of skills.`
	});
	for (const dup of input.skills.duplicateDescriptions.slice(0, 5)) out.push({
		severity: "medium",
		text: `${dup.count} skills have identical descriptions (e.g. "${dup.name}"); the catalog is redundant; merge them or differentiate the descriptions.`
	});
	if (input.skills.bodies !== void 0 && input.skills.bodies.totalTokens > 2e4) out.push({
		severity: "low",
		text: `Counted ${input.skills.bodies.count} skill bodies totaling about ${formatTokens(input.skills.bodies.totalTokens)} tokens (loaded on demand, not resident in requests).`
	});
	if (input.tools.mcp.totalTokens > 4e3 || input.tools.mcp.totalTools > 20) out.push({
		severity: "high",
		text: `MCP tool surface bloat: ${input.tools.mcp.totalTools} tools with ~${formatTokens(input.tools.mcp.totalTokens)} tokens of schema. Largest servers: ${input.tools.mcp.servers.slice(0, 3).map((s) => `${s.server} (${s.tools} tools)`).join(', ')}. Consider pruning servers or tools you do not need.`
	});
	if (input.tools.visibleCount > 40) out.push({
		severity: "low",
		text: `${input.tools.visibleCount} visible tools (~${formatTokens(input.tools.schemaTokens)} tokens of schema) are carried on every request; check whether all of them are needed.`
	});
	for (const conflict of input.conflicts.slice(0, 5)) out.push({
		severity: "medium",
		text: `Skill "${conflict.name}" has multiple sources: ${conflict.winner.source}(${conflict.winner.provider}) wins, ${conflict.shadowed.map((s) => `${s.source}(${s.provider})`).join(', ')} are shadowed; only the winner is loaded.`
	});
	return out;
}
/** 把 canonical 报告渲染成模型可读文本。 */
function renderReport(report) {
	const lines = [];
	lines.push(`# Context Doctor Audit Report (cwd: ${report.cwd})`);
	lines.push("");
	const inst = report.injected.instructions;
	lines.push(`## 1. Instruction chain (AGENTS.md / CLAUDE.md)`);
	lines.push(`- Injected files: ${inst.files.length}, totaling ${formatTokens(inst.totalTokens)} tokens`);
	for (const f of inst.files) lines.push(`  - ${f.path} (${formatTokens(f.tokens)} tokens / ${formatBytes(f.bytes)})`);
	if (inst.duplicateBlocks.length > 0) {
		lines.push(`- ⚠ Cross-file duplicate blocks: ${inst.duplicateBlocks.length}`);
		for (const b of inst.duplicateBlocks.slice(0, 5)) lines.push(`  - ${formatTokens(b.tokens)} tokens × ${b.paths.length} files: ${b.paths.join(', ')}`);
	} else lines.push("- No cross-file duplicate blocks found");
	lines.push("");
	const sk = report.injected.skills;
	lines.push(`## 2. Skill catalog (resident on every request)`);
	lines.push(`- ${sk.catalogCount} skills, ${formatTokens(sk.catalogDescriptionTokens)} tokens of descriptions`);
	for (const s of sk.bySource) lines.push(`  - ${s.source}: ${s.count} / ${formatTokens(s.descriptionTokens)} tokens`);
	if (sk.bodies !== void 0) lines.push(`- Skill bodies (loaded on demand): ${sk.bodies.count} counted, about ${formatTokens(sk.bodies.totalTokens)} tokens total`);
	if (sk.duplicateDescriptions.length > 0) {
		lines.push(`- ⚠ Duplicate descriptions: ${sk.duplicateDescriptions.length} groups`);
		for (const d of sk.duplicateDescriptions.slice(0, 5)) lines.push(`  - ${d.count} skills share one description (e.g. "${d.name}")`);
	}
	lines.push("");
	const tl = report.injected.tools;
	lines.push(`## 3. Tool schemas (resident on every request)`);
	lines.push(`- ${tl.visibleCount} visible tools, ${formatTokens(tl.schemaTokens)} tokens of schema (${tl.nativeCount} native / ${formatTokens(tl.nativeTokens)} tokens)`);
	if (tl.mcp.totalTools > 0) {
		lines.push(`- MCP: ${tl.mcp.totalTools} tools / ${formatTokens(tl.mcp.totalTokens)} tokens`);
		for (const s of tl.mcp.servers) lines.push(`  - ${s.server}: ${s.tools} tools / ${formatTokens(s.schemaTokens)} tokens`);
	}
	lines.push("");
	if (report.conflicts.length > 0) {
		lines.push(`## 4. Same-name skill conflicts (rank shadow)`);
		for (const c of report.conflicts) lines.push(`- ${c.name}: ${c.winner.source}(${c.winner.provider}) wins; ${c.shadowed.map((s) => `${s.source}(${s.provider})`).join(', ')} shadowed`);
		lines.push("");
	}
	lines.push(`## 5. Suggestions (${report.suggestions.length})`);
	if (report.suggestions.length === 0) lines.push("- No significant issues found; the current injection surface is healthy.");
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
		for (const duplicate of receipt.duplicateMcpEntries) lines.push(`  - duplicate MCP signature ${duplicate.schemaHash}: ${duplicate.names.join(', ')} (${formatBytes(duplicate.bytes)})`);
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
	const audit = (cwd, detail) => {
		const key = `${detail} ${cwd}`;
		const hit = cache.get(key);
		if (hit !== void 0 && Date.now() - hit.at < cacheTtlMs) return hit.promise;
		if (cache.size >= MAX_CACHE_ENTRIES) {
			const oldest = cache.keys().next().value;
			if (oldest !== void 0) cache.delete(oldest);
		}
		const promise = runAudit(deps, {
			cwd,
			detail,
			signal: new AbortController().signal
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
			audit(resolveCwd(req.url ?? "", config), parseQueryParam(req.url ?? "", "detail") === "developer" ? "developer" : "summary").then((report) => json(res, 200, {
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
	ctx.tools.register(defineTool({
		name: "context_audit",
		description: "Audit the context injections of the current session: the AGENTS.md/CLAUDE.md instruction chain, skill catalog summaries, tool schemas, and MCP tools.Estimate the token cost of each injection, detect cross-file duplicate blocks, duplicate skill descriptions, same-name skill shadowing, and MCP tool surface bloat,and output pruning suggestions sorted by severity. Read-only; does not modify any files.",
		parameters: {
			cwd: {
				type: "string",
				description: "Directory to audit; defaults to the current session working directory"
			},
			includeSkillBodies: {
				type: "boolean",
				description: "Whether to count the total tokens of skill bodies (loads each skill body, slower); default false"
			},
			maxSkillBodies: {
				type: "number",
				description: "Maximum number of skill bodies to count when includeSkillBodies is enabled; default 20"
			},
			detail: {
				type: "string",
				enum: ["summary", "developer"],
				description: "Output level: summary is a condensed overview; developer also includes an addressable context-audit receipt"
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true
			},
			render: (_args, value) => [{
				type: "text",
				text: renderReport(value)
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
				...exec.agent !== void 0 ? { agent: exec.agent } : {}
			});
		}
	}));
	const sessions = ctx.get("sessions");
	const routes = makeAuditRoutes({
		deps,
		...sessions !== void 0 ? { sessions } : {},
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
export { apply, buildSuggestions, inject, name, rankOfSource, renderReport };
