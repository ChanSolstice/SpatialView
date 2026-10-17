import { beforeAll, describe, expect, it } from 'vitest'
import { memoryPreferences } from '../platform/index.ts'
import defaults from './config.json'
import { checkPassword, prepareOverride, resetOverride, saveOverride } from './engineering.ts'
import { loadConfig, OVERRIDE_KEY } from './load.ts'

let digest = ''
beforeAll(async () => {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('2468'))
  digest = [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('')
})

describe('checkPassword', () => {
  it('按 SHA-256 摘要比较', async () => {
    expect(await checkPassword('2468', digest)).toBe(true)
    expect(await checkPassword('1357', digest)).toBe(false)
  })

  it('打包时没有设置密码：任何输入都不通过', async () => {
    expect(await checkPassword('', '')).toBe(false)
    expect(await checkPassword('2468', '')).toBe(false)
  })
})

describe('prepareOverride（需求 10.3：保存前检查 JSON 格式和必填字段）', () => {
  const edited = (patch: (c: typeof defaults) => void) => {
    const config = structuredClone(defaults)
    patch(config)
    return JSON.stringify(config)
  }

  it('只保存改过的字段和默认配置版本', () => {
    const result = prepareOverride(edited((c) => (c.server.rosbridge_url = 'ws://10.0.0.5:9090')))
    expect(result).toEqual({
      override: { server: { rosbridge_url: 'ws://10.0.0.5:9090' }, config_version: 1 },
    })
  })

  it('不是有效的 JSON、缺少必填字段、取值不合法', () => {
    expect(prepareOverride('{ "server": ')).toMatchObject({
      error: expect.stringContaining('不是有效的 JSON'),
    })
    expect(prepareOverride('[]')).toEqual({ error: '配置应为 JSON 对象' })
    expect(prepareOverride(edited((c) => delete (c as Partial<typeof c>).timing))).toMatchObject({
      error: expect.stringContaining('timing'),
    })
    expect(prepareOverride(edited((c) => (c.server.http_base_url = 'ftp://x')))).toMatchObject({
      error: expect.stringContaining('http://'),
    })
  })

  it('保存后启动时合并生效；恢复默认删除覆盖配置', async () => {
    const preferences = memoryPreferences()
    const result = prepareOverride(edited((c) => (c.animation.speeds = [1, 2])))
    if (!('override' in result)) throw new Error(result.error)
    await saveOverride(preferences, result.override)
    const loaded = await loadConfig(preferences)
    expect(loaded.config.animation.speeds).toEqual([1, 2])
    expect(loaded.overrideVersion).toBe(1)
    await resetOverride(preferences)
    expect(await preferences.get(OVERRIDE_KEY)).toBeNull()
  })
})
