/**
 * 工程面板（需求 10.3；前端UI设计 4.7）：常用项表单和完整 JSON 编辑、恢复默认、保存，底部显示版本，
 * 包括交付时需要记录的 WebView 版本（架构设计 5.10）。
 * 保存或恢复默认后重新加载页面，按新配置重新连接。面板在对话框之上、急停区之下，急停仍然可按。
 */
import { useMemo, useState } from 'react'
import { prepareOverride, resetOverride, saveOverride } from '../../config/engineering.ts'
import { DEFAULT_CONFIG } from '../../config/load.ts'
import { isJsonObject, type JsonObject } from '../../domain/configMerge.ts'
import { webViewVersion } from '../../platform/webview.ts'
import { INTERFACE_VERSION } from '../../ros/contract.ts'
import { useRuntime } from '../runtimeContext.ts'

interface Props {
  onClose(): void
  /** 保存、恢复默认之后重新加载，按新配置启动（测试中替换） */
  reload?: () => void
}

const FIELDS = [
  ['rosbridge_url', 'ROSbridge 地址'],
  ['http_base_url', 'HTTP 地址'],
] as const

function parse(text: string): JsonObject | null {
  try {
    const value: unknown = JSON.parse(text)
    return isJsonObject(value) ? value : null
  } catch {
    return null
  }
}

export function EngineeringPanel({ onClose, reload = () => window.location.reload() }: Props) {
  const { config, preferences } = useRuntime()
  const [text, setText] = useState(() => JSON.stringify(config.config, null, 2))
  const [error, setError] = useState<string | null>(null)
  const parsed = useMemo(() => parse(text), [text])
  const server = parsed && isJsonObject(parsed.server) ? parsed.server : null

  const setServer = (key: string, value: string) => {
    if (!parsed || !server) return
    setText(JSON.stringify({ ...parsed, server: { ...server, [key]: value } }, null, 2))
  }
  const save = async () => {
    const result = prepareOverride(text)
    if ('error' in result) return setError(result.error)
    await saveOverride(preferences, result.override)
    reload()
  }
  const reset = async () => {
    await resetOverride(preferences)
    reload()
  }
  const versionChanged =
    config.overrideVersion !== null && config.overrideVersion !== DEFAULT_CONFIG.config_version

  return (
    <div className="eng" role="region" aria-label="工程设置" data-testid="engineering-panel">
      <div className="eng-head">
        <button type="button" className="tool-button" onClick={onClose}>
          返回
        </button>
        <div className="eng-title">工程设置</div>
      </div>
      <div className="eng-body">
        {versionChanged && (
          <div className="eng-note">
            覆盖配置保存于配置版本 {config.overrideVersion}，当前默认配置版本为{' '}
            {DEFAULT_CONFIG.config_version}，请检查各项是否仍然适用
          </div>
        )}
        {config.overrideError && <div className="eng-note is-error">{config.overrideError}</div>}
        <div className="eng-fields">
          {FIELDS.map(([key, label]) => (
            <label className="eng-field" key={key}>
              <span>{label}</span>
              <input
                className="eng-input"
                value={typeof server?.[key] === 'string' ? server[key] : ''}
                disabled={!server}
                onChange={(e) => setServer(key, e.target.value)}
              />
            </label>
          ))}
        </div>
        <label className="eng-field">
          <span>完整配置（JSON）</span>
          <textarea
            className="eng-json"
            spellCheck={false}
            value={text}
            onChange={(e) => {
              setText(e.target.value)
              setError(null)
            }}
          />
        </label>
        {!parsed && <div className="eng-error">不是有效的 JSON，上面的表单暂时不能编辑</div>}
        {error && <div className="eng-error eng-error-block">{error}</div>}
        <div className="eng-actions">
          <button type="button" className="dbtn" onClick={() => void reset()}>
            恢复默认
          </button>
          <button type="button" className="dbtn primary" onClick={() => void save()}>
            保存
          </button>
        </div>
      </div>
      <div className="eng-foot">
        <span>APP 版本 {__APP_VERSION__}</span>
        <span>期望接口版本 {INTERFACE_VERSION}</span>
        <span>WebView 版本 {webViewVersion(navigator.userAgent) ?? '未知'}</span>
        <span>默认配置版本 {DEFAULT_CONFIG.config_version}</span>
        <span>覆盖配置版本 {config.overrideVersion ?? '无'}</span>
      </div>
    </div>
  )
}
