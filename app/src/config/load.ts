/**
 * 启动时加载配置（需求 10.1）：内置默认配置与 Preferences 中的覆盖配置合并后校验。
 * 覆盖配置无法使用（JSON 损坏、合并后不合法）时使用默认配置，并给出原因，供工程入口显示。
 */
import { isJsonObject, mergeConfig, type JsonObject } from '../domain/configMerge.ts'
import type { PreferenceStore } from '../platform/index.ts'
import defaultsJson from './config.json'
import { configSchema, describeIssues, type Config } from './schema.ts'

/** Preferences 中保存覆盖配置的键。 */
export const OVERRIDE_KEY = 'spatialview.config_override'

export const DEFAULT_CONFIG: Config = configSchema.parse(defaultsJson)

export interface LoadedConfig {
  config: Config
  /** 覆盖配置保存时的默认配置版本；没有覆盖配置时为 null。 */
  overrideVersion: number | null
  /** 覆盖配置无法使用的原因；为 null 表示没有问题。 */
  overrideError: string | null
}

/**
 * 开发时的服务端地址（Vite 的 VITE_ROSBRIDGE_URL、VITE_HTTP_BASE_URL），替换默认配置中的地址，
 * 覆盖配置仍然优先。只在开发服务器中生效，不进入打包产物。
 */
export interface DevServerUrls {
  rosbridge_url?: string
  http_base_url?: string
}

export function devServerUrls(): DevServerUrls {
  if (!import.meta.env.DEV) return {}
  const urls: DevServerUrls = {}
  if (import.meta.env.VITE_ROSBRIDGE_URL) urls.rosbridge_url = import.meta.env.VITE_ROSBRIDGE_URL
  if (import.meta.env.VITE_HTTP_BASE_URL) urls.http_base_url = import.meta.env.VITE_HTTP_BASE_URL
  return urls
}

export async function loadConfig(
  preferences: PreferenceStore,
  dev: DevServerUrls = {},
): Promise<LoadedConfig> {
  const defaults = {
    ...(defaultsJson as JsonObject),
    server: { ...DEFAULT_CONFIG.server, ...dev },
  }
  let raw: string | null
  try {
    raw = await preferences.get(OVERRIDE_KEY)
  } catch (error) {
    return fallback(defaults, null, `读取覆盖配置失败：${String(error)}`)
  }
  if (raw === null) return fallback(defaults, null, null)

  let override: unknown
  try {
    override = JSON.parse(raw)
  } catch {
    return fallback(defaults, null, '覆盖配置不是有效的 JSON')
  }
  if (!isJsonObject(override)) return fallback(defaults, null, '覆盖配置不是 JSON 对象')
  const version = typeof override.config_version === 'number' ? override.config_version : null

  const merged = configSchema.safeParse(mergeConfig(defaults, override))
  if (!merged.success) {
    return fallback(
      defaults,
      version,
      `覆盖配置不合法，已使用默认配置：\n${describeIssues(merged.error)}`,
    )
  }
  return { config: merged.data, overrideVersion: version, overrideError: null }
}

function fallback(
  defaults: JsonObject,
  version: number | null,
  error: string | null,
): LoadedConfig {
  return { config: configSchema.parse(defaults), overrideVersion: version, overrideError: error }
}
