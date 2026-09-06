/**
 * 启发式 token 估算。
 *
 * 不依赖外部 tokenizer：英文（ASCII）约 4 字符/token，中文等非 ASCII 约 1.5
 * 字符/token。结果用于比较相对成本与趋势，不是精确计数（精确值以模型
 * tokenizer 为准）。
 */

export function estimateTokens(text: string): number {
  let ascii = 0
  let nonAscii = 0
  for (const ch of text) {
    if (ch.codePointAt(0)! < 0x80) ascii++
    else nonAscii++
  }
  return Math.ceil(ascii / 4 + nonAscii / 1.5)
}

/**
 * 把 token 数格式化为人类可读：1234 -> "1.2k"，50000 -> "50k"。
 *
 * 浏览器半区也直接引这个函数——本模块无 node 依赖，纯字符串运算。面板此前
 * 自带过一份副本，两份漂移后同一个数字在报告里显示 "50.0k"、在面板里 "50k"。
 */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  const k = n / 1000
  if (k >= 100 || Number.isInteger(k)) return `${Math.round(k)}k`
  return `${k.toFixed(1)}k`
}

/** 把字节数格式化为人类可读。 */
export function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${n} B`
}
