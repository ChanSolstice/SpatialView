import { describe, expect, it } from 'vitest'
import { memoryPreferences, type PreferenceStore } from '../platform/index.ts'
import { DEFAULT_CONFIG, loadConfig, OVERRIDE_KEY } from './load.ts'

const saved = (value: unknown) =>
  memoryPreferences({
    [OVERRIDE_KEY]: typeof value === 'string' ? value : JSON.stringify(value),
  })

describe('loadConfig（需求 10.1）', () => {
  it('没有覆盖配置时使用默认配置', async () => {
    expect(await loadConfig(memoryPreferences())).toEqual({
      config: DEFAULT_CONFIG,
      overrideVersion: null,
      overrideError: null,
    })
  })

  it('合并覆盖配置，并记录保存时的配置版本', async () => {
    const loaded = await loadConfig(
      saved({ config_version: 1, server: { rosbridge_url: 'ws://10.0.0.5:9090' } }),
    )
    expect(loaded.config.server).toEqual({
      rosbridge_url: 'ws://10.0.0.5:9090',
      http_base_url: DEFAULT_CONFIG.server.http_base_url,
    })
    expect(loaded.config.config_version).toBe(DEFAULT_CONFIG.config_version)
    expect(loaded.overrideVersion).toBe(1)
    expect(loaded.overrideError).toBeNull()
  })

  it('覆盖配置不是有效的 JSON 时使用默认配置并给出原因', async () => {
    const loaded = await loadConfig(saved('{"server":'))
    expect(loaded.config).toEqual(DEFAULT_CONFIG)
    expect(loaded.overrideError).toContain('JSON')
  })

  it('合并后不合法时使用默认配置，原因写明字段', async () => {
    const loaded = await loadConfig(
      saved({
        config_version: 1,
        timing: { state_timeout_ms: -1 },
        server: { rosbridge_url: 'x' },
      }),
    )
    expect(loaded.config).toEqual(DEFAULT_CONFIG)
    expect(loaded.overrideVersion).toBe(1)
    expect(loaded.overrideError).toContain('timing.state_timeout_ms')
    expect(loaded.overrideError).toContain('server.rosbridge_url')
  })

  it('缩放范围颠倒时不合法', async () => {
    const loaded = await loadConfig(saved({ scene: { zoom_min_ratio: 8 } }))
    expect(loaded.overrideError).toContain('zoom_min_ratio')
  })

  it('读取 Preferences 失败时使用默认配置', async () => {
    const broken: PreferenceStore = {
      ...memoryPreferences(),
      get: () => Promise.reject(new Error('disk')),
    }
    const loaded = await loadConfig(broken)
    expect(loaded.config).toEqual(DEFAULT_CONFIG)
    expect(loaded.overrideError).toContain('disk')
  })

  it('开发服务器的地址替换默认地址，覆盖配置仍然优先', async () => {
    const dev = { rosbridge_url: 'ws://localhost:9090', http_base_url: 'http://localhost:8080' }
    expect((await loadConfig(memoryPreferences(), dev)).config.server).toEqual(dev)
    const loaded = await loadConfig(saved({ server: { rosbridge_url: 'ws://10.0.0.5:9090' } }), dev)
    expect(loaded.config.server).toEqual({
      rosbridge_url: 'ws://10.0.0.5:9090',
      http_base_url: 'http://localhost:8080',
    })
  })
})
