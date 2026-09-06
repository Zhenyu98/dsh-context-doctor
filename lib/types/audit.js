import { createHash } from 'node:crypto';
import { findRankShadows } from "./analyze.js";
import { hostTranslate } from "./locale.js";
import { scanInstructionChain, scanSkillCatalog, scanToolSchemas } from "./scan.js";
import { estimateTokens, formatBytes, formatTokens } from "./tokens.js";
/** 执行一次完整审计。 */
export async function runAudit(deps, options) {
    const { fs, skills, tools } = deps;
    const { cwd, signal } = options;
    // 技能查询必须带 scope。宿主 SkillViewOptions 写明「omitted reads the global
    // layer alone」，而技能实际注册在调用方所在的 project / runtime / user 层，
    // 不传 scope 时 catalog 恒为空（issue #8）。宿主自己的 tool-skill 就是这个
    // 写法：agent 本身即 scope key。
    const skillLookup = {
        cwd,
        signal,
        ...(typeof options.agent === 'object' && options.agent !== null ? { scope: options.agent } : {}),
    };
    // skills.list 只调一次：技能目录统计与冲突检测共用同一份列表。
    const skillList = await skills.list(skillLookup);
    const [instructions, skillCatalog, toolSchemas] = await Promise.all([
        scanInstructionChain(fs, cwd, signal),
        scanSkillCatalog(skillList, signal),
        scanToolSchemas(tools, options.agent, signal),
    ]);
    // 可选：统计技能正文总 token（前 N 个）
    let bodies;
    if (options.includeSkillBodies === true) {
        const max = Math.max(1, Math.min(options.maxSkillBodies ?? 20, 100));
        let count = 0;
        let totalTokens = 0;
        for (const summary of skillList.slice(0, max)) {
            try {
                const def = await skills.get(summary.name, skillLookup);
                if (def !== undefined) {
                    count++;
                    totalTokens += estimateTokens(def.content);
                }
            }
            catch {
                // 单个技能加载失败不影响整体
            }
        }
        bodies = { count, totalTokens };
    }
    const conflicts = findRankShadows(skillList.map((s) => ({
        name: s.name,
        source: s.source,
        provider: s.provider,
        rank: rankOfSource(s.source),
    })));
    const suggestions = buildSuggestions({
        instructions,
        skills: { ...skillCatalog, ...(bodies !== undefined ? { bodies } : {}) },
        tools: toolSchemas,
        conflicts,
    }, options.locale ?? 'en');
    const report = {
        tool: 'context_audit',
        version: 1,
        cwd,
        injected: {
            instructions: {
                root: instructions.root,
                files: instructions.files,
                totalTokens: instructions.totalTokens,
                duplicateBlocks: instructions.duplicateBlocks.map((b) => ({ tokens: b.tokens, paths: b.paths })),
            },
            skills: {
                catalogCount: skillCatalog.count,
                catalogDescriptionTokens: skillCatalog.totalDescriptionTokens,
                bySource: skillCatalog.bySource,
                duplicateDescriptions: skillCatalog.duplicateDescriptions,
                ...(bodies !== undefined ? { bodies } : {}),
            },
            tools: {
                visibleCount: toolSchemas.visibleCount,
                schemaTokens: toolSchemas.schemaTokens,
                nativeCount: toolSchemas.nativeCount,
                nativeTokens: toolSchemas.nativeTokens,
                mcp: toolSchemas.mcp,
            },
        },
        conflicts,
        suggestions,
    };
    if (options.detail === 'developer') {
        report.receipt = buildDeveloperReceipt({
            instructions,
            skillList,
            toolSchemas,
            conflicts,
            suggestions,
        });
    }
    return report;
}
function byteLength(value) {
    return new TextEncoder().encode(value).byteLength;
}
function sha256(value) {
    return createHash('sha256').update(value).digest('hex');
}
function preview(value, max = 160) {
    const compact = value.replace(/\s+/g, ' ').trim();
    return compact.length <= max ? compact : `${compact.slice(0, max - 1)}…`;
}
function buildDeveloperReceipt(input) {
    const agentsFiles = input.instructions.files.map((file, index) => ({
        ...file,
        loadOrder: index + 1,
        duplicateBlocks: input.instructions.duplicateBlocks
            .filter(block => block.paths.includes(file.path))
            .map(block => ({ sha256: sha256(block.text), tokens: block.tokens, paths: block.paths, preview: preview(block.text) })),
    }));
    const skills = input.skillList.map(skill => ({
        name: skill.name,
        source: skill.source,
        provider: skill.provider,
        descriptionBytes: byteLength(skill.description),
        descriptionTokens: estimateTokens(skill.description),
        catalogInjected: true,
    }));
    const schemaItems = input.toolSchemas.items.map(item => ({
        name: item.name,
        bytes: item.bytes,
        tokens: item.tokens,
        schemaHash: item.schemaHash,
        ...(item.server !== undefined ? { server: item.server } : {}),
    }));
    const duplicateMcpEntries = [...input.toolSchemas.mcpDuplicates.entries()]
        .filter(([, items]) => items.length > 1)
        .map(([schemaHash, items]) => ({
        schemaHash,
        names: items.map(item => item.name).sort(),
        servers: [...new Set(items.map(item => item.server))].sort(),
        bytes: items.reduce((total, item) => total + item.bytes, 0),
    }))
        .sort((a, b) => b.bytes - a.bytes || a.schemaHash.localeCompare(b.schemaHash));
    return {
        kind: 'context-audit-receipt',
        version: 1,
        detail: 'developer',
        agentsFiles,
        skills,
        toolSchemas: { totalBytes: schemaItems.reduce((total, item) => total + item.bytes, 0), items: schemaItems },
        duplicateMcpEntries,
        shadowedSkills: input.conflicts,
        trimmed: { status: 'unavailable', items: [] },
        repairPlan: input.suggestions,
    };
}
/** SkillSummary 的 rank 不在公开类型里；按来源给启发式排序值（与官方 rank 语义一致：低者胜）。 */
export function rankOfSource(source) {
    switch (source) {
        case 'project-dsh': return 100;
        case 'project-agents': return 200;
        case 'runtime': return 250;
        case 'user-dsh': return 300;
        case 'user-agents': return 400;
        case 'custom': return 500;
        case 'bundled': return 600;
        default: return 900;
    }
}
/** 按严重度排序的裁剪建议。 */
export function buildSuggestions(input, locale = 'en') {
    const t = hostTranslate(locale);
    const sep = t('sep');
    const out = [];
    if (input.instructions.totalTokens > 8000) {
        out.push({
            severity: 'high',
            text: t('s.instHeavy', { tokens: formatTokens(input.instructions.totalTokens) }),
        });
    }
    for (const block of input.instructions.duplicateBlocks.slice(0, 5)) {
        out.push({
            severity: 'medium',
            text: t('s.dupBlock', {
                tokens: formatTokens(block.tokens),
                n: block.paths.length,
                paths: block.paths.join(sep),
            }),
        });
    }
    if (input.skills.totalDescriptionTokens > 3000) {
        out.push({
            severity: 'medium',
            text: t('s.skillCatalog', {
                tokens: formatTokens(input.skills.totalDescriptionTokens),
                n: input.skills.count,
            }),
        });
    }
    for (const dup of input.skills.duplicateDescriptions.slice(0, 5)) {
        out.push({
            severity: 'medium',
            text: t('s.dupSkillDesc', { n: dup.count, name: dup.name }),
        });
    }
    if (input.skills.bodies !== undefined && input.skills.bodies.totalTokens > 20000) {
        out.push({
            severity: 'low',
            text: t('s.skillBodies', {
                n: input.skills.bodies.count,
                tokens: formatTokens(input.skills.bodies.totalTokens),
            }),
        });
    }
    if (input.tools.mcp.totalTokens > 4000 || input.tools.mcp.totalTools > 20) {
        out.push({
            severity: 'high',
            text: t('s.mcpBloat', {
                n: input.tools.mcp.totalTools,
                tokens: formatTokens(input.tools.mcp.totalTokens),
                servers: input.tools.mcp.servers.slice(0, 3).map((s) => `${s.server}(${s.tools})`).join(sep),
            }),
        });
    }
    if (input.tools.visibleCount > 40) {
        out.push({
            severity: 'low',
            text: t('s.manyTools', {
                n: input.tools.visibleCount,
                tokens: formatTokens(input.tools.schemaTokens),
            }),
        });
    }
    for (const conflict of input.conflicts.slice(0, 5)) {
        out.push({
            severity: 'medium',
            text: t('s.conflict', {
                name: conflict.name,
                winner: `${conflict.winner.source}(${conflict.winner.provider})`,
                shadowed: conflict.shadowed.map((s) => `${s.source}(${s.provider})`).join(sep),
            }),
        });
    }
    return out;
}
/** 把 canonical 报告渲染成模型可读文本。 */
export function renderReport(report, locale = 'en') {
    const t = hostTranslate(locale);
    const sep = t('sep');
    const lines = [];
    lines.push(t('r.title', { cwd: report.cwd }));
    lines.push('');
    const inst = report.injected.instructions;
    lines.push(t('r.s1'));
    lines.push(t('r.instFiles', { n: inst.files.length, tokens: formatTokens(inst.totalTokens) }));
    for (const f of inst.files) {
        lines.push(t('r.instFile', { path: f.path, tokens: formatTokens(f.tokens), bytes: formatBytes(f.bytes) }));
    }
    if (inst.duplicateBlocks.length > 0) {
        lines.push(t('r.dupBlocks', { n: inst.duplicateBlocks.length }));
        for (const b of inst.duplicateBlocks.slice(0, 5)) {
            lines.push(t('r.dupBlock', { tokens: formatTokens(b.tokens), files: b.paths.length, paths: b.paths.join(sep) }));
        }
    }
    else {
        lines.push(t('r.noDup'));
    }
    lines.push('');
    const sk = report.injected.skills;
    lines.push(t('r.s2'));
    lines.push(t('r.skills', { n: sk.catalogCount, tokens: formatTokens(sk.catalogDescriptionTokens) }));
    for (const s of sk.bySource) {
        lines.push(t('r.skillSource', { source: s.source, count: s.count, tokens: formatTokens(s.descriptionTokens) }));
    }
    if (sk.bodies !== undefined) {
        lines.push(t('r.bodies', { n: sk.bodies.count, tokens: formatTokens(sk.bodies.totalTokens) }));
    }
    if (sk.duplicateDescriptions.length > 0) {
        lines.push(t('r.dupDesc', { n: sk.duplicateDescriptions.length }));
        for (const d of sk.duplicateDescriptions.slice(0, 5)) {
            lines.push(t('r.dupDescItem', { count: d.count, name: d.name }));
        }
    }
    lines.push('');
    const tl = report.injected.tools;
    lines.push(t('r.s3'));
    lines.push(t('r.tools', {
        n: tl.visibleCount,
        tokens: formatTokens(tl.schemaTokens),
        native: tl.nativeCount,
        nativeTokens: formatTokens(tl.nativeTokens),
    }));
    if (tl.mcp.totalTools > 0) {
        lines.push(t('r.mcp', { n: tl.mcp.totalTools, tokens: formatTokens(tl.mcp.totalTokens) }));
        for (const s of tl.mcp.servers) {
            lines.push(t('r.mcpServer', { server: s.server, tools: s.tools, tokens: formatTokens(s.schemaTokens) }));
        }
    }
    lines.push('');
    if (report.conflicts.length > 0) {
        lines.push(t('r.s4'));
        for (const c of report.conflicts) {
            lines.push(t('r.conflict', {
                name: c.name,
                winner: `${c.winner.source}(${c.winner.provider})`,
                shadowed: c.shadowed.map((s) => `${s.source}(${s.provider})`).join(sep),
            }));
        }
        lines.push('');
    }
    lines.push(t('r.s5', { n: report.suggestions.length }));
    if (report.suggestions.length === 0) {
        lines.push(t('r.noIssues'));
    }
    for (const s of report.suggestions) {
        lines.push(`- [${s.severity}] ${s.text}`);
    }
    if (report.receipt !== undefined) {
        const receipt = report.receipt;
        lines.push('');
        lines.push('## Developer context-audit receipt');
        lines.push(`- AGENTS files: ${receipt.agentsFiles.length}`);
        for (const file of receipt.agentsFiles) {
            lines.push(`  - #${file.loadOrder} ${file.path}: ${formatBytes(file.bytes)} / ${formatTokens(file.tokens)} token`);
            for (const duplicate of file.duplicateBlocks) {
                lines.push(`    - duplicate ${duplicate.sha256.slice(0, 12)}… (${formatTokens(duplicate.tokens)} token): ${duplicate.preview}`);
            }
        }
        lines.push(`- Catalog-injected skills: ${receipt.skills.length}`);
        for (const skill of receipt.skills) {
            lines.push(`  - ${skill.name} [${skill.source}/${skill.provider}]: ${formatBytes(skill.descriptionBytes)} / ${formatTokens(skill.descriptionTokens)} token`);
        }
        lines.push(`- Tool schemas: ${formatBytes(receipt.toolSchemas.totalBytes)} serialized across ${receipt.toolSchemas.items.length} tools`);
        for (const duplicate of receipt.duplicateMcpEntries) {
            lines.push(`  - duplicate MCP signature ${duplicate.schemaHash}: ${duplicate.names.join('、')} (${formatBytes(duplicate.bytes)})`);
        }
        lines.push(`- Shadowed skills: ${receipt.shadowedSkills.length}`);
        lines.push(`- Trimmed entries: ${receipt.trimmed.status} (DSH assembly trace is not exposed)`);
    }
    return lines.join('\n');
}
