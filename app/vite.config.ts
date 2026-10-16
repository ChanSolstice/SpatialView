/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    // 页面随 APK 打包，从本地读取，不经网络下载（架构设计 5.10）；three.js 所在的包约 0.85 MB
    chunkSizeWarningLimit: 1200,
  },
  test: {
    // 默认在 Node 中运行；需要 DOM 的测试文件在开头写 `// @vitest-environment jsdom`
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}', 'tests/**/*.test.{ts,tsx}'],
  },
})
