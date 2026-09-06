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
        description: '审计当前会话的上下文注入物：AGENTS.md/CLAUDE.md 指令链、技能目录摘要（catalog）、工具 schema、MCP 工具。'
            + '估算每项注入的 token 成本，检测跨文件重复段落、技能描述重复、同名技能 shadow、MCP 工具面膨胀，'
            + '输出按严重度排序的裁剪建议。只读，不修改任何文件。',
        parameters: {
            cwd: { type: 'string', description: '审计起点目录；默认使用当前会话工作目录' },
            includeSkillBodies: {
                type: 'boolean',
                description: '是否统计技能正文的总 token（需要逐个加载技能正文，较慢）；默认 false',
            },
            maxSkillBodies: {
                type: 'number',
                description: 'includeSkillBodies 时最多统计的技能个数；默认 20',
            },
            detail: {
                type: 'string',
                enum: ['summary', 'developer'],
                description: '输出层级：summary 为精简摘要；developer 额外附带可定位的 context-audit receipt',
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
    // sessions / agents 都是可选的（headless 无），用 ctx.get 读取、缺省则不传。
    // agents 用来把 `session=<id>` 还原成 agent —— 技能查询的 scope key，缺了它
    // 面板里的技能目录会恒为 0（issue #8）。sessionId 是 agent 注册表与会话日志
    // 共用的同一个身份，所以同一个 id 两边都能查。
    const sessions = ctx.get('sessions');
    const agents = ctx.get('agents');
    const routes = makeAuditRoutes({
        deps,
        ...(sessions !== undefined ? { sessions: sessions } : {}),
        ...(agents !== undefined ? { agents: agents } : {}),
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
