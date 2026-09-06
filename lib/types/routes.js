import { runAudit } from "./audit.js";
import { resolveHostLocale } from "./locale.js";
/** 浏览器侧 API 前缀。 */
export const AUDIT_API_PREFIX = '/api/context-doctor';
/** 写 JSON 响应。 */
function json(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
}
/** 从查询字符串取单个参数（URL 解码；重复取首个）。 */
function parseQueryParam(url, key) {
    const query = url.includes('?') ? url.slice(url.indexOf('?') + 1) : '';
    for (const part of query.split('&')) {
        if (!part.startsWith(`${key}=`))
            continue;
        try {
            return decodeURIComponent(part.slice(key.length + 1));
        }
        catch {
            return undefined;
        }
    }
    return undefined;
}
/** 解析审计起点目录：显式 cwd > 会话 cwd > defaultCwd > 进程 cwd。 */
function resolveCwd(url, config) {
    const explicit = parseQueryParam(url, 'cwd');
    if (explicit !== undefined && explicit !== '')
        return explicit;
    const sessionId = parseQueryParam(url, 'session');
    if (sessionId !== undefined && sessionId !== '') {
        const session = config.sessions?.get(sessionId);
        if (session?.header.cwd !== undefined && session.header.cwd !== '') {
            return session.header.cwd;
        }
    }
    return config.defaultCwd ?? process.cwd();
}
/** 构造审计路由（含 60s 缓存与 in-flight 复用）。 */
export function makeAuditRoutes(config) {
    const { deps, cacheTtlMs = 60_000 } = config;
    const cache = new Map();
    /** 缓存条目上限：防止不同 cwd 参数让缓存无限增长（超限时淘汰最旧条目）。 */
    const MAX_CACHE_ENTRIES = 32;
    const audit = (cwd, detail, agent, sessionId, locale) => {
        // 缓存键要带上明细层级（两种报告结构不同）、会话（不同 agent 看到的技能层
        // 不同）和语言（建议文案随语言变化）。
        const key = `${detail} ${locale} ${sessionId} ${cwd}`;
        const hit = cache.get(key);
        if (hit !== undefined && Date.now() - hit.at < cacheTtlMs)
            return hit.promise;
        if (cache.size >= MAX_CACHE_ENTRIES) {
            const oldest = cache.keys().next().value;
            if (oldest !== undefined)
                cache.delete(oldest);
        }
        const promise = runAudit(deps, {
            cwd,
            detail,
            locale,
            signal: new AbortController().signal,
            ...(agent !== undefined ? { agent } : {}),
        })
            .catch((error) => {
            // 失败不缓存，允许下次重试
            cache.delete(key);
            throw error;
        });
        cache.set(key, { at: Date.now(), promise });
        return promise;
    };
    return [{
            kind: 'exact',
            path: `${AUDIT_API_PREFIX}/audit`,
            handler: (req, res) => {
                if (req.method !== 'GET') {
                    json(res, 405, { ok: false, error: 'method-not-allowed' });
                    return;
                }
                const url = req.url ?? '';
                const cwd = resolveCwd(url, config);
                // `detail=developer` 附带逐条 receipt，浏览器面板用它展开「谁在占用」。
                const detail = parseQueryParam(url, 'detail') === 'developer' ? 'developer' : 'summary';
                // agent 是技能查询的 scope key；解析不到时退化为不带 scope 的旧行为
                // （技能目录会是空的），但其余各项照常统计。
                const sessionId = parseQueryParam(url, 'session') ?? '';
                const agent = sessionId === '' ? undefined : config.agents?.get(sessionId);
                // 面板显式带上自己的语言：宿主设置里的 locale.preference 可以缺省（缺省
                // 即「跟随浏览器」），而 host 看不见浏览器（issue #11）。
                const locale = resolveHostLocale(parseQueryParam(url, 'lang'));
                audit(cwd, detail, agent, sessionId, locale).then((report) => json(res, 200, { ok: true, report }), (error) => json(res, 500, {
                    ok: false,
                    error: error instanceof Error ? error.message : String(error),
                }));
            },
        }];
}
