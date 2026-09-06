/**
 * Context Doctor — DSH 上下文注入审计插件。
 *
 * - host 半区：注册 `context_audit` 工具 + `GET /api/context-doctor/audit` 路由
 * - 浏览器半区（`./client`）：composer 圆环 + 展开面板（见 src/client/）
 */
import type { Context } from '@deepseek-ai/cordis';
export type { AuditReport } from './audit.ts';
export declare const name = "context-doctor";
export declare const inject: readonly ["fs", "skills", "tools", "sessions"];
/** 插件配置。 */
export interface Config {
    /** 审计默认目录（浏览器面板不带 cwd 参数时使用；缺省为进程启动目录）。 */
    defaultCwd?: string;
    /** 审计结果缓存时长（毫秒）。默认 60000。 */
    cacheTtlMs?: number;
}
export declare function apply(ctx: Context, config?: Config): void;
