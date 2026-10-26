/**
 * WebView 版本（需求 3.5；架构设计 5.10）：Android System WebView 的 User-Agent 中，Chrome/ 后面的版本号
 * 就是 WebView 的版本。工程面板显示它，交付时据此记录该批平板的 WebView 版本。
 */
export function webViewVersion(userAgent: string): string | null {
  return /\bChrome\/([\d.]+)/.exec(userAgent)?.[1] ?? null
}
