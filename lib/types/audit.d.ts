/**
 * 审计引擎：context_audit 工具与 HTTP 路由共用的核心逻辑。
 */
import type { FileSystem } from '@deepseek-ai/dsh-fs';
import type { SkillRegistry } from '@deepseek-ai/dsh-skill';
import type { ToolRuntime } from '@deepseek-ai/dsh-tools';
import { type HostLocaleId } from './locale.ts';
/** 审计报告（canonical JSON 值）。 */
export interface AuditReport {
    tool: 'context_audit';
    version: 1;
    cwd: string;
    injected: {
        instructions: {
            root: string;
            files: {
                path: string;
                bytes: number;
                tokens: number;
            }[];
            totalTokens: number;
            duplicateBlocks: {
                tokens: number;
                paths: string[];
            }[];
        };
        skills: {
            catalogCount: number;
            catalogDescriptionTokens: number;
            bySource: {
                source: string;
                count: number;
                descriptionTokens: number;
            }[];
            duplicateDescriptions: {
                name: string;
                description: string;
                count: number;
            }[];
            bodies?: {
                count: number;
                totalTokens: number;
            };
        };
        tools: {
            visibleCount: number;
            schemaTokens: number;
            nativeCount: number;
            nativeTokens: number;
            mcp: {
                servers: {
                    server: string;
                    tools: number;
                    schemaTokens: number;
                }[];
                totalTools: number;
                totalTokens: number;
            };
        };
    };
    conflicts: {
        name: string;
        winner: {
            source: string;
            provider: string;
        };
        shadowed: {
            source: string;
            provider: string;
        }[];
    }[];
    suggestions: {
        severity: 'high' | 'medium' | 'low';
        text: string;
    }[];
    /** 仅 `detail=developer` 时附加：供 Agent 定点修复的上下文审计回执。 */
    receipt?: ContextAuditReceipt;
}
/** 开发者明细回执；所有条目均来自当前可观测的注入面。 */
export interface ContextAuditReceipt {
    kind: 'context-audit-receipt';
    version: 1;
    detail: 'developer';
    agentsFiles: {
        path: string;
        bytes: number;
        tokens: number;
        loadOrder: number;
        duplicateBlocks: {
            sha256: string;
            tokens: number;
            paths: string[];
            preview: string;
        }[];
    }[];
    skills: {
        name: string;
        source: string;
        provider: string;
        descriptionBytes: number;
        descriptionTokens: number;
        /** 条目在模型每请求可见的 skills catalog 中；不表示技能正文已按需读取。 */
        catalogInjected: true;
    }[];
    toolSchemas: {
        totalBytes: number;
        items: {
            name: string;
            bytes: number;
            tokens: number;
            schemaHash: string;
            server?: string;
        }[];
    };
    duplicateMcpEntries: {
        schemaHash: string;
        names: string[];
        servers: string[];
        bytes: number;
    }[];
    shadowedSkills: AuditReport['conflicts'];
    /** DSH 未暴露 assembly trace 时，必须保持 unavailable，不能推测裁剪结果。 */
    trimmed: {
        status: 'unavailable';
        items: [];
    };
    repairPlan: AuditReport['suggestions'];
}
/** 审计引擎依赖的服务面（工具执行与 HTTP 路由共用）。 */
export interface AuditDeps {
    fs: FileSystem;
    skills: SkillRegistry;
    tools: ToolRuntime;
}
/** 审计选项。 */
export interface AuditOptions {
    cwd: string;
    signal: AbortSignal;
    /** 是否统计技能正文总 token（逐个加载正文，较慢）。 */
    includeSkillBodies?: boolean;
    /** includeSkillBodies 时最多统计的技能个数。 */
    maxSkillBodies?: number;
    /** `developer` 附加可定位的 context-audit receipt；默认只返回摘要。 */
    detail?: 'summary' | 'developer';
    /** 当前执行上下文（工具执行时传入 exec.agent，用于解析会话 cwd）。 */
    agent?: unknown;
    /**
     * 建议文案的语言（issue #11）。报告是给人读的，跟随宿主语言；工具 schema
     * 是给模型读的，固定英文，不受此项影响。缺省为英文。
     */
    locale?: HostLocaleId;
}
/** 执行一次完整审计。 */
export declare function runAudit(deps: AuditDeps, options: AuditOptions): Promise<AuditReport>;
/** SkillSummary 的 rank 不在公开类型里；按来源给启发式排序值（与官方 rank 语义一致：低者胜）。 */
export declare function rankOfSource(source: string): number;
interface SuggestionInput {
    instructions: {
        totalTokens: number;
        duplicateBlocks: {
            tokens: number;
            paths: string[];
        }[];
    };
    skills: {
        count: number;
        totalDescriptionTokens: number;
        bySource: {
            source: string;
            count: number;
            descriptionTokens: number;
        }[];
        duplicateDescriptions: {
            name: string;
            description: string;
            count: number;
        }[];
        bodies?: {
            count: number;
            totalTokens: number;
        };
    };
    tools: {
        visibleCount: number;
        schemaTokens: number;
        mcp: {
            servers: {
                server: string;
                tools: number;
                schemaTokens: number;
            }[];
            totalTools: number;
            totalTokens: number;
        };
    };
    conflicts: {
        name: string;
        winner: {
            source: string;
            provider: string;
        };
        shadowed: {
            source: string;
            provider: string;
        }[];
    }[];
}
/** 按严重度排序的裁剪建议。 */
export declare function buildSuggestions(input: SuggestionInput, locale?: HostLocaleId): {
    severity: 'high' | 'medium' | 'low';
    text: string;
}[];
/** 把 canonical 报告渲染成模型可读文本。 */
export declare function renderReport(report: AuditReport, locale?: HostLocaleId): string;
export {};
