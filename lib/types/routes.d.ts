import type { WebRoute } from '@deepseek-ai/dsh-host-webserver';
import type { AuditDeps } from './audit.ts';
/** 浏览器侧 API 前缀。 */
export declare const AUDIT_API_PREFIX = "/api/context-doctor";
/** 审计接口配置。 */
export interface AuditRoutesConfig {
    deps: AuditDeps;
    /**
     * 会话存储：`session=<id>` 参数存在时用它解析当前会话工作目录，
     * 使审计落在用户正在查看的会话上（技能/工具/指令链数据才完整）。
     * 缺省时回退 defaultCwd / process.cwd()。
     */
    sessions?: {
        get(id: string): {
            header: {
                cwd?: string;
            };
        } | undefined;
    };
    /**
     * Agent 注册表：`session=<id>` 参数存在时用它还原调用方 agent。agent 即技能
     * 查询的 scope key，没有它宿主「只读 global 层」，面板的技能目录恒为 0
     * （issue #8）。sessionId 是 agent 注册表与会话日志共用的同一个身份。
     */
    agents?: {
        get(id: string): object | undefined;
    };
    /** 默认审计目录（cwd/session 参数都缺省时使用）。 */
    defaultCwd?: string;
    /** 结果缓存时长（毫秒）。默认 60s。 */
    cacheTtlMs?: number;
}
/** 构造审计路由（含 60s 缓存与 in-flight 复用）。 */
export declare function makeAuditRoutes(config: AuditRoutesConfig): WebRoute[];
