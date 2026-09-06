/**
 * Context Doctor — DSH 上下文注入审计插件。
 *
 * - host 半区：注册 `context_audit` 工具 + `GET /api/context-doctor/audit` 路由
 * - 浏览器半区（`./client`）：composer 圆环 + 展开面板（见 src/client/）
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
// `JsonValue` moved out of dsh-tools into dsh-util-values in DSH 0.1.2;
// type-only, so it is erased at build time and needs no peer dependency.
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
// Type-only side-effect imports: pull each package's `declare module '@deepseek-ai/cordis'`
// Context augmentation (fs / skills / tools / webServer) into this compilation unit.
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-session'
import { renderReport, runAudit, type AuditDeps, type AuditReport } from './audit.ts'
import {
  LOCALE_PREFERENCE_FIELD, LOCALE_SETTINGS_NAMESPACE, resolveHostLocale, type HostLocaleId,
} from './locale.ts'
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

  /**
   * 报告语言（issue #11）。宿主把显式选择存在 settings 的 `locale.preference`，
   * 但该字段可缺省，缺省即「跟随浏览器」——host 看不见浏览器，只能回退英文。
   * 浏览器面板不受这个限制：它在请求里显式带上自己的语言（见 routes.ts）。
   */
  const reportLocale = (): HostLocaleId => {
    const settings = ctx.get('settings') as
      { get(ns: string): unknown } | undefined
    const section = settings?.get(LOCALE_SETTINGS_NAMESPACE) as
      Record<string, unknown> | undefined
    return resolveHostLocale(section?.[LOCALE_PREFERENCE_FIELD])
  }

  // 1. 模型工具。
  //
  // description 与参数说明**固定英文**：它们是给模型读的 schema，不是给人读的
  // 界面文案。DSH 自带工具（tool-skill、tool-fs-search 等）一律英文，而让 schema
  // 随宿主语言变化只会让模型行为随设置漂移。给人读的报告在 output.render 里按
  // 语言渲染。
  ctx.tools.register(defineTool({
    name: 'context_audit',
    description:
      'Audit what this session injects into every model request: the AGENTS.md / CLAUDE.md '
      + 'instruction chain, the skills catalog, tool schemas, and MCP tools. Estimates the token '
      + 'cost of each, detects blocks duplicated across files, skills sharing one description, '
      + 'same-name skills shadowing each other, and MCP tool-surface bloat, then returns trimming '
      + 'suggestions ordered by severity. Read-only: it never modifies a file.',
    parameters: {
      cwd: { type: 'string', description: 'Directory to audit from. Defaults to the current session workspace.' },
      includeSkillBodies: {
        type: 'boolean',
        description: 'Also total the tokens of skill bodies. Loads each body, so it is slower. Defaults to false.',
      },
      maxSkillBodies: {
        type: 'number',
        description: 'How many skill bodies to count when includeSkillBodies is set. Defaults to 20.',
      },
      detail: {
        type: 'string',
        enum: ['summary', 'developer'],
        description: 'Output level: "summary" for the digest, "developer" to also attach a per-entry context-audit receipt.',
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value: Record<string, JsonValue>) => [
        { type: 'text', text: renderReport(value as unknown as AuditReport, reportLocale()) },
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
        locale: reportLocale(),
      })
      // AuditReport 结构保证值全部 JSON 安全；断言仅为满足 defineTool 的 JsonValue 签名。
      return report as unknown as Record<string, JsonValue>
    },
  }))

  // 2. HTTP 路由（浏览器圆环面板的数据通道）。webServer 是可选能力：
  //    有 web 服务时注册（浏览器半区数据源），headless/CLI 环境没有该服务
  //    时自动跳过，context_audit 工具不受影响。
  // sessions / agents 都是可选的（headless 无），用 ctx.get 读取、缺省则不传。
  // agents 用来把 `session=<id>` 还原成 agent —— 技能查询的 scope key，缺了它
  // 面板里的技能目录会恒为 0（issue #8）。sessionId 是 agent 注册表与会话日志
  // 共用的同一个身份，所以同一个 id 两边都能查。
  const sessions = ctx.get('sessions')
  const agents = ctx.get('agents')
  const routes = makeAuditRoutes({
    deps,
    ...(sessions !== undefined ? { sessions: sessions as never } : {}),
    ...(agents !== undefined ? { agents: agents as never } : {}),
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
