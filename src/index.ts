/**
 * Context Doctor — DSH 上下文注入审计插件。
 *
 * - host 半区：注册 `context_audit` 工具 + `GET /api/context-doctor/audit` 路由
 * - 浏览器半区（`./client`）：composer 圆环 + 展开面板（见 src/client/）
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type JsonValue } from '@deepseek-ai/dsh-tools'
// Type-only side-effect imports: pull each package's `declare module '@deepseek-ai/cordis'`
// Context augmentation (fs / skills / tools / webServer) into this compilation unit.
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-session'
import { renderReport, runAudit, type AuditDeps, type AuditReport } from './audit.ts'
import { makeAuditRoutes } from './routes.ts'

export type { AuditReport } from './audit.ts'
export { buildSuggestions, rankOfSource, renderReport } from './audit.ts'

export const name = 'context-doctor'
export const inject = ['fs', 'skills', 'tools', 'sessions'] as const

/** 插件配置。 */
export interface Config {
  /** 审计默认目录（浏览器面板不带 cwd 参数时使用；缺省为进程启动目录）。 */
  defaultCwd?: string
  /** 审计结果缓存时长（毫秒）。默认 60000。 */
  cacheTtlMs?: number
}

export function apply(ctx: Context, config: Config = {}): void {
  const deps: AuditDeps = { fs: ctx.fs, skills: ctx.skills, tools: ctx.tools }

  // 1. 模型工具
  ctx.tools.register(defineTool({
    name: 'context_audit',
    description:
      'Audit the context injections of the current session: the AGENTS.md/CLAUDE.md instruction chain, skill catalog summaries, tool schemas, and MCP tools.'
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
      render: (_args, value: Record<string, JsonValue>) => [
        { type: 'text', text: renderReport(value as unknown as AuditReport) },
      ],
    },
    async execute(args, exec): Promise<Record<string, JsonValue>> {
      const agentCwd = (exec.agent as { session?: { header?: { cwd?: string } } } | undefined)
        ?.session?.header?.cwd
      const cwd = args.cwd ?? agentCwd ?? config.defaultCwd ?? process.cwd()
      const report = await runAudit(deps, {
        cwd,
        signal: exec.signal,
        ...(args.includeSkillBodies !== undefined ? { includeSkillBodies: args.includeSkillBodies } : {}),
        ...(args.maxSkillBodies !== undefined ? { maxSkillBodies: args.maxSkillBodies } : {}),
        ...(args.detail === 'developer' ? { detail: 'developer' as const } : {}),
        ...(exec.agent !== undefined ? { agent: exec.agent } : {}),
      })
      // AuditReport 结构保证值全部 JSON 安全；断言仅为满足 defineTool 的 JsonValue 签名。
      return report as unknown as Record<string, JsonValue>
    },
  }))

  // 2. HTTP 路由（浏览器圆环面板的数据通道）。webServer 是可选能力：
  //    有 web 服务时注册（浏览器半区数据源），headless/CLI 环境没有该服务
  //    时自动跳过，context_audit 工具不受影响。
  // sessions 是可选的（headless 无），用 ctx.get 读取、缺省则不传。
  const sessions = ctx.get('sessions')
  const routes = makeAuditRoutes({
    deps,
    ...(sessions !== undefined ? { sessions: sessions as never } : {}),
    ...(config.defaultCwd !== undefined ? { defaultCwd: config.defaultCwd } : {}),
    ...(config.cacheTtlMs !== undefined ? { cacheTtlMs: config.cacheTtlMs } : {}),
  })
  ctx.inject(['webServer'], (httpCtx) => {
    httpCtx.effect(() => {
      const disposers = routes.map((route) => httpCtx.webServer.register(route))
      return () => {
        for (const dispose of disposers) dispose()
      }
    }, 'context-doctor: routes')
  })
}
