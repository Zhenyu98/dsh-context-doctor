/**
 * 启发式 token 估算。
 *
 * 不依赖外部 tokenizer：英文（ASCII）约 4 字符/token，中文等非 ASCII 约 1.5
 * 字符/token。结果用于比较相对成本与趋势，不是精确计数（精确值以模型
 * tokenizer 为准）。
 */
export declare function estimateTokens(text: string): number;
/**
 * 把 token 数格式化为人类可读：1234 -> "1.2k"，50000 -> "50k"。
 *
 * 浏览器半区也直接引这个函数——本模块无 node 依赖，纯字符串运算。面板此前
 * 自带过一份副本，两份漂移后同一个数字在报告里显示 "50.0k"、在面板里 "50k"。
 */
export declare function formatTokens(n: number): string;
/** 把字节数格式化为人类可读。 */
export declare function formatBytes(n: number): string;
