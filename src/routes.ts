/**
 * Context Doctor HTTP 路由：浏览器半区通过同源 JSON 接口拉取审计报告
 * （`GET /api/context-doctor/audit`）。与 dsh-pet-web 的 /api/pet/* 同款模式。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { AuditDeps, AuditReport } from './audit.ts'
import { runAudit } from './audit.ts'

/** 浏览器侧 API 前缀。 */
export const AUDIT_API_PREFIX = '/api/context-doctor'

/** 审计接口配置。 */
export interface AuditRoutesConfig {
  deps: AuditDeps
  /**
   * 会话存储：`session=<id>` 参数存在时用它解析当前会话工作目录，
   * 使审计落在用户正在查看的会话上（技能/工具/指令链数据才完整）。
   * 缺省时回退 defaultCwd / process.cwd()。
   */
  sessions?: { get(id: string): { header: { cwd?: string } } | undefined }
  /**
   * Agent 注册表：`session=<id>` 参数存在时用它还原调用方 agent。agent 即技能
   * 查询的 scope key，没有它宿主「只读 global 层」，面板的技能目录恒为 0
   * （issue #8）。sessionId 是 agent 注册表与会话日志共用的同一个身份。
   */
  agents?: { get(id: string): object | undefined }
  /** 默认审计目录（cwd/session 参数都缺省时使用）。 */
  defaultCwd?: string
  /** 结果缓存时长（毫秒）。默认 60s。 */
  cacheTtlMs?: number
}

/** 写 JSON 响应。 */
function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/** 从查询字符串取单个参数（URL 解码；重复取首个）。 */
function parseQueryParam(url: string, key: string): string | undefined {
  const query = url.includes('?') ? url.slice(url.indexOf('?') + 1) : ''
  for (const part of query.split('&')) {
    if (!part.startsWith(`${key}=`)) continue
    try {
      return decodeURIComponent(part.slice(key.length + 1))
    } catch {
      return undefined
    }
  }
  return undefined
}

/** 解析审计起点目录：显式 cwd > 会话 cwd > defaultCwd > 进程 cwd。 */
function resolveCwd(
  url: string,
  config: Pick<AuditRoutesConfig, 'sessions' | 'defaultCwd'>,
): string {
  const explicit = parseQueryParam(url, 'cwd')
  if (explicit !== undefined && explicit !== '') return explicit
  const sessionId = parseQueryParam(url, 'session')
  if (sessionId !== undefined && sessionId !== '') {
    const session = config.sessions?.get(sessionId)
    if (session?.header.cwd !== undefined && session.header.cwd !== '') {
      return session.header.cwd
    }
  }
  return config.defaultCwd ?? process.cwd()
}

/** 构造审计路由（含 60s 缓存与 in-flight 复用）。 */
export function makeAuditRoutes(config: AuditRoutesConfig): WebRoute[] {
  const { deps, cacheTtlMs = 60_000 } = config
  const cache = new Map<string, { at: number; promise: Promise<AuditReport> }>()
  /** 缓存条目上限：防止不同 cwd 参数让缓存无限增长（超限时淘汰最旧条目）。 */
  const MAX_CACHE_ENTRIES = 32

  const audit = (
    cwd: string,
    detail: 'summary' | 'developer',
    agent: object | undefined,
    sessionId: string,
  ): Promise<AuditReport> => {
    // 缓存键要带上明细层级（两种报告结构不同）和会话（不同 agent 看到的技能层
    // 不同，报告也就不同）。
    const key = `${detail} ${sessionId} ${cwd}`
    const hit = cache.get(key)
    if (hit !== undefined && Date.now() - hit.at < cacheTtlMs) return hit.promise
    if (cache.size >= MAX_CACHE_ENTRIES) {
      const oldest = cache.keys().next().value
      if (oldest !== undefined) cache.delete(oldest)
    }
    const promise = runAudit(deps, {
      cwd,
      detail,
      signal: new AbortController().signal,
      ...(agent !== undefined ? { agent } : {}),
    })
      .catch((error: unknown) => {
        // 失败不缓存，允许下次重试
        cache.delete(key)
        throw error
      })
    cache.set(key, { at: Date.now(), promise })
    return promise
  }

  return [{
    kind: 'exact',
    path: `${AUDIT_API_PREFIX}/audit`,
    handler: (req: IncomingMessage, res: ServerResponse): void => {
      if (req.method !== 'GET') {
        json(res, 405, { ok: false, error: 'method-not-allowed' })
        return
      }
      const url = req.url ?? ''
      const cwd = resolveCwd(url, config)
      // `detail=developer` 附带逐条 receipt，浏览器面板用它展开「谁在占用」。
      const detail = parseQueryParam(url, 'detail') === 'developer' ? 'developer' : 'summary'
      // agent 是技能查询的 scope key；解析不到时退化为不带 scope 的旧行为
      // （技能目录会是空的），但其余各项照常统计。
      const sessionId = parseQueryParam(url, 'session') ?? ''
      const agent = sessionId === '' ? undefined : config.agents?.get(sessionId)
      audit(cwd, detail, agent, sessionId).then(
        (report) => json(res, 200, { ok: true, report }),
        (error: unknown) => json(res, 500, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      )
    },
  }]
}
