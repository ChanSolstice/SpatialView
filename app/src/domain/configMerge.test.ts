import { describe, expect, it } from 'vitest'
import { diffConfig, mergeConfig } from './configMerge.ts'

const defaults = {
  config_version: 2,
  server: { rosbridge_url: 'ws://192.168.1.100:9090', http_base_url: 'http://192.168.1.100:8080' },
  timing: { state_timeout_ms: 3000, reconnect_interval_ms: 2000 },
  robot: { packages: { aubo_description: 'robot/aubo_description' } },
  animation: { speeds: [1, 5, 20] },
}

describe('mergeConfig（需求 10.1）', () => {
  it('没有覆盖配置时使用默认配置', () => {
    expect(mergeConfig(defaults, null)).toEqual(defaults)
  })

  it('覆盖配置中存在的字段使用覆盖值，其余使用默认值', () => {
    const merged = mergeConfig(defaults, {
      config_version: 2,
      server: { rosbridge_url: 'ws://10.0.0.5:9090' },
    })
    expect(merged.server).toEqual({
      rosbridge_url: 'ws://10.0.0.5:9090',
      http_base_url: 'http://192.168.1.100:8080',
    })
    expect(merged.timing).toEqual(defaults.timing)
  })

  it('数组整体替换', () => {
    expect(mergeConfig(defaults, { animation: { speeds: [2] } }).animation).toEqual({ speeds: [2] })
  })

  it('映射表逐项合并，可以增加映射', () => {
    const merged = mergeConfig(defaults, { robot: { packages: { tool: 'robot/tool' } } })
    expect(merged.robot).toEqual({
      packages: { aubo_description: 'robot/aubo_description', tool: 'robot/tool' },
    })
  })

  it('config_version 取默认配置的，覆盖配置中的只表示保存时的版本', () => {
    expect(mergeConfig(defaults, { config_version: 1 }).config_version).toBe(2)
  })

  it('APK 升级后默认配置新增的字段照常使用默认值', () => {
    const upgraded = { ...defaults, scene: { tap_threshold_px: 8 } }
    const merged = mergeConfig(upgraded, { config_version: 1, timing: { state_timeout_ms: 4000 } })
    expect(merged.scene).toEqual({ tap_threshold_px: 8 })
    expect(merged.timing).toEqual({ state_timeout_ms: 4000, reconnect_interval_ms: 2000 })
  })

  it('不修改传入的对象', () => {
    const before = JSON.stringify(defaults)
    mergeConfig(defaults, { server: { rosbridge_url: 'ws://x:1' } })
    expect(JSON.stringify(defaults)).toBe(before)
  })
})

describe('diffConfig（需求 10.1：只保存改过的字段）', () => {
  const base = {
    config_version: 3,
    server: { rosbridge_url: 'ws://a:9090', http_base_url: 'http://a:8080' },
    animation: { speeds: [1, 5, 20] },
    scene: { grid_size_m: 4 },
  }

  it('只保留与默认配置不同的字段，数组整体保存，记录默认配置版本', () => {
    const edited = {
      ...base,
      server: { ...base.server, rosbridge_url: 'ws://b:9090' },
      animation: { speeds: [1, 10] },
    }
    expect(diffConfig(base, edited)).toEqual({
      server: { rosbridge_url: 'ws://b:9090' },
      animation: { speeds: [1, 10] },
      config_version: 3,
    })
  })

  it('没有改动时只有版本；编辑内容中的 config_version 不影响', () => {
    expect(diffConfig(base, { ...base, config_version: 99 })).toEqual({ config_version: 3 })
  })

  it('合并回默认配置后与编辑后的配置一致', () => {
    const edited = {
      ...base,
      scene: { grid_size_m: 6 },
      server: { ...base.server, http_base_url: 'http://c' },
    }
    expect(mergeConfig(base, diffConfig(base, edited))).toEqual(edited)
  })
})
