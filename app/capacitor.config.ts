/**
 * Capacitor 配置（需求 3.5；架构设计 5.10）。ROSbridge 是 ws://、文件服务是 http://，页面也用 http 提供，
 * 并允许明文流量，否则会被当成混合内容拦截。
 */
import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.spatialview.app',
  appName: 'SpatialView',
  webDir: 'dist',
  server: {
    androidScheme: 'http',
    cleartext: true,
  },
}

export default config
