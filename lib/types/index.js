import { defineTool } from '@deepseek-ai/dsh-tools';
import { renderReport, runAudit } from "./audit.js";
import { makeAuditRoutes } from "./routes.js";
export { buildSuggestions, rankOfSource, renderReport } from "./audit.js";
export const name = 'context-doctor';
export const inject = ['fs', 'skills', 'tools', 'sessions'];
export function apply(ctx, config = {}) {
    const deps = { fs: ctx.fs, skills: ctx.skills, tools: ctx.tools };
    // 1. 模型工具
    ctx.tools.register(defineTool({
        name: 'context_audit',
        description: 'Audit the context injections of the current session: the AGENTS.md/CLAUDE.md instruction chain, skill catalog summaries, tool schemas, and MCP tools.'
            + 'Estimate the token cost of each injection, detect cross-file duplicate blocks, duplicate skill descriptions, same-name skill shadowing, and MCP tool surface bloat,'
            + 'and output pruning suggestions sorted by severity. Read-only; does not modify any files.',
        parameters: {
            cwd: { type: 'string', description: 'Directory to audit; defaults to the current session working directory' },
            includeSkillBodies: {
                type: 'boolean',
                description: 'Whether to count the total tokens of skill bodies (loads each skill body, slower); default false',
            },
            maxSkillBodies: {
                type: 'number',
                description: 'Maximum number of skill bodies to count when includeSkillBodies is enabled; default 20',
            },
            detail: {
                type: 'string',
                enum: ['summary', 'developer'],
                description: 'Output level: summary is a condensed overview; developer also includes an addressable context-audit receipt',
            },
        },
        output: {
            schema: { type: 'object', additionalProperties: true },
            render: (_args, value) => [
                { type: 'text', text: renderReport(value) },
            ],
        },
        async execute(args, exec) {
            const agentCwd = exec.agent
                ?.session?.header?.cwd;
            const cwd = args.cwd ?? agentCwd ?? config.defaultCwd ?? process.cwd();
            const report = await runAudit(deps, {
                cwd,
                signal: exec.signal,
                ...(args.includeSkillBodies !== undefined ? { includeSkillBodies: args.includeSkillBodies } : {}),
                ...(args.maxSkillBodies !== undefined ? { maxSkillBodies: args.maxSkillBodies } : {}),
                ...(args.detail === 'developer' ? { detail: 'developer' } : {}),
                ...(exec.agent !== undefined ? { agent: exec.agent } : {}),
            });
            // AuditReport 结构保证值全部 JSON 安全；断言仅为满足 defineTool 的 JsonValue 签名。
            return report;
        },
    }));
    // 2. HTTP 路由（浏览器圆环面板的数据通道）。webServer 是可选能力：
    //    有 web 服务时注册（浏览器半区数据源），headless/CLI 环境没有该服务
    //    时自动跳过，context_audit 工具不受影响。
    // sessions 是可选的（headless 无），用 ctx.get 读取、缺省则不传。
    const sessions = ctx.get('sessions');
    const routes = makeAuditRoutes({
        deps,
        ...(sessions !== undefined ? { sessions: sessions } : {}),
        ...(config.defaultCwd !== undefined ? { defaultCwd: config.defaultCwd } : {}),
        ...(config.cacheTtlMs !== undefined ? { cacheTtlMs: config.cacheTtlMs } : {}),
    });
    ctx.inject(['webServer'], (httpCtx) => {
        httpCtx.effect(() => {
            const disposers = routes.map((route) => httpCtx.webServer.register(route));
            return () => {
                for (const dispose of disposers)
                    dispose();
            };
        }, 'context-doctor: routes');
    });
}
