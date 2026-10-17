/**
 * 工程入口（需求 10.3；架构设计 5.8）：密码校验和覆盖配置的保存、恢复默认。
 * 密码在打包时以 SHA-256 摘要写入（vite.config.ts），产物中没有明文。
 */
import { diffConfig, isJsonObject, type JsonObject } from '../domain/configMerge.ts'
import type { PreferenceStore } from '../platform/index.ts'
import defaultsJson from './config.json'
import { OVERRIDE_KEY } from './load.ts'
import { configSchema, describeIssues } from './schema.ts'

/** 编译开关：关闭时工程入口和长按逻辑都不进入打包产物。 */
export const ENGINEERING_ENABLED = import.meta.env.VITE_ENABLE_ENGINEERING === 'true'

async function sha256(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export async function checkPassword(
  input: string,
  digest = __ENGINEERING_PASSWORD_SHA256__,
): Promise<boolean> {
  return digest !== '' && (await sha256(input)) === digest
}

/** 检查编辑后的完整配置：JSON 格式和必填字段（需求 10.3）。返回错误说明，或要保存的覆盖配置。 */
export function prepareOverride(text: string): { error: string } | { override: JsonObject } {
  let edited: unknown
  try {
    edited = JSON.parse(text)
  } catch (error) {
    return { error: `不是有效的 JSON：${error instanceof Error ? error.message : String(error)}` }
  }
  if (!isJsonObject(edited)) return { error: '配置应为 JSON 对象' }
  const checked = configSchema.safeParse(edited)
  if (!checked.success) return { error: describeIssues(checked.error) }
  return { override: diffConfig(defaultsJson as JsonObject, edited) }
}

export async function saveOverride(
  preferences: PreferenceStore,
  override: JsonObject,
): Promise<void> {
  await preferences.set(OVERRIDE_KEY, JSON.stringify(override))
}

/** 恢复默认：删除覆盖配置（需求 10.1）。 */
export async function resetOverride(preferences: PreferenceStore): Promise<void> {
  await preferences.remove(OVERRIDE_KEY)
}
