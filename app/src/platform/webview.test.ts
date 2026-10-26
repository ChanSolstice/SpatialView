import { describe, expect, it } from 'vitest'
import { webViewVersion } from './webview.ts'

describe('WebView 版本', () => {
  it('取 User-Agent 中 Chrome/ 后面的版本号', () => {
    const android =
      'Mozilla/5.0 (Linux; Android 14; P100 Build/UP1A.231005.007; wv) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Version/4.0 Chrome/131.0.6778.135 Safari/537.36'
    expect(webViewVersion(android)).toBe('131.0.6778.135')
  })

  it('没有 Chrome 版本时为 null', () => {
    expect(webViewVersion('Mozilla/5.0 (linux) AppleWebKit/537.36 jsdom/26.1.0')).toBeNull()
  })
})
