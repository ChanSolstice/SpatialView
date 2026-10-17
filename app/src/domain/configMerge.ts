/**
 * 默认配置与覆盖配置的合并（需求 10.1）：覆盖配置中存在的字段使用覆盖值，不存在的字段使用默认值；
 * 对象逐层合并，数组和其他值整体替换。覆盖配置中的 config_version 是保存时的默认配置版本，不参与合并。
 * 工程入口保存时反过来，只保存与默认配置不同的字段（diffConfig）。
 */

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function mergeValue(base: JsonValue | undefined, override: JsonValue): JsonValue {
  if (isJsonObject(base) && isJsonObject(override)) {
    const result: JsonObject = { ...base }
    for (const [key, value] of Object.entries(override)) {
      result[key] = mergeValue(base[key], value)
    }
    return result
  }
  return override
}

export function mergeConfig(defaults: JsonObject, override: JsonObject | null): JsonObject {
  if (override === null) return defaults
  const { config_version: _savedVersion, ...values } = override
  return mergeValue(defaults, values) as JsonObject
}

function sameValue(a: JsonValue | undefined, b: JsonValue): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function diffValue(base: JsonValue | undefined, edited: JsonValue): JsonValue | undefined {
  if (isJsonObject(base) && isJsonObject(edited)) {
    const result: JsonObject = {}
    for (const [key, value] of Object.entries(edited)) {
      const changed = diffValue(base[key], value)
      if (changed !== undefined) result[key] = changed
    }
    return Object.keys(result).length > 0 ? result : undefined
  }
  return sameValue(base, edited) ? undefined : edited
}

/**
 * 工程入口保存的覆盖配置（需求 10.1）：只保存与默认配置不同的字段，数组整体保存；
 * 记录保存时的默认配置版本 config_version。
 */
export function diffConfig(defaults: JsonObject, edited: JsonObject): JsonObject {
  const { config_version: _edited, ...values } = edited
  const { config_version: version, ...base } = defaults
  const changed = diffValue(base, values)
  return { ...(isJsonObject(changed) ? changed : {}), config_version: version ?? null }
}
