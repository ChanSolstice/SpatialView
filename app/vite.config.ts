/// <reference types="vitest/config" />
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

const { version } = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf-8'),
) as {
  version: string
}

// https://vite.dev/config/
export default defineConfig(({ command, mode }) => {
  // 工程入口（需求 10.3；架构设计 5.8）：VITE_ENABLE_ENGINEERING 为 true 时打包进产物。
  // 密码从环境变量 SPATIALVIEW_ENGINEERING_PASSWORD 读取，产物中只有 SHA-256 摘要；
  // 变量名不以 VITE_ 开头，明文不会进入产物
  const engineering = loadEnv(mode, process.cwd()).VITE_ENABLE_ENGINEERING === 'true'
  const password = process.env.SPATIALVIEW_ENGINEERING_PASSWORD ?? ''
  if (engineering && password === '' && command === 'build') {
    throw new Error('启用工程入口时，需要用环境变量 SPATIALVIEW_ENGINEERING_PASSWORD 设置密码')
  }
  return {
    plugins: [react()],
    define: {
      __APP_VERSION__: JSON.stringify(version),
      __ENGINEERING_PASSWORD_SHA256__: JSON.stringify(
        password === '' ? '' : createHash('sha256').update(password).digest('hex'),
      ),
    },
    build: {
      // 页面随 APK 打包，从本地读取，不经网络下载（架构设计 5.10）；three.js 所在的包约 0.85 MB
      chunkSizeWarningLimit: 1200,
    },
    test: {
      // 默认在 Node 中运行；需要 DOM 的测试文件在开头写 `// @vitest-environment jsdom`
      environment: 'node',
      include: ['src/**/*.test.{ts,tsx}', 'tests/**/*.test.{ts,tsx}'],
    },
  }
})
