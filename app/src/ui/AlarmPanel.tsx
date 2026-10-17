/**
 * 告警面板（需求 9.2；前端UI设计 4.6）：从 Status Bar 的告警按钮下方展开，按时间倒序列出服务端告警和本地告警。
 * 点击面板外任意位置或关闭按钮收起。点击不被拦截：面板打开时按急停，急停照常发送。
 */
import { useEffect, useRef } from 'react'
import { formatAlarmTime } from '../domain/alarms.ts'
import { selectAlarmItems } from '../store/selectors.ts'
import { Icon } from './Icon.tsx'
import { useApp, useRuntime } from './runtimeContext.ts'
import './AlarmPanel.css'

/** 告警按钮（StatusBar）；点击它由按钮自己切换面板，不算面板外。 */
const ALARM_BUTTON = '[data-testid="sb-alarm"]'

export function AlarmPanel() {
  const { store } = useRuntime()
  const open = useApp((s) => s.alarmPanelOpen)
  const items = useApp(selectAlarmItems)
  const offline = useApp((s) => s.conn.status !== 'connected')
  const panel = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => {
      const target = event.target as Node | null
      if (!target || panel.current?.contains(target)) return
      if ((target as Element).closest?.(ALARM_BUTTON)) return
      store.getState().setAlarmPanel(false)
    }
    document.addEventListener('pointerdown', outside, true)
    return () => document.removeEventListener('pointerdown', outside, true)
  }, [open, store])

  if (!open) return null
  const before = offline && items.some((item) => !item.local)
  return (
    <div className="alarms" ref={panel} role="region" aria-label="告警" data-testid="alarm-panel">
      <div className="alarms-head">
        告警（{items.length}）
        <button
          type="button"
          className="alarms-close"
          aria-label="关闭"
          onClick={() => store.getState().setAlarmPanel(false)}
        >
          <Icon name="close" />
        </button>
      </div>
      {/* 断线期间面板保留断线前的服务端告警（需求 7.4） */}
      {before && <div className="alarms-note">以下为断线前的告警</div>}
      <div className="alarms-list">
        {items.length === 0 && <div className="alarms-empty">当前没有告警</div>}
        {items.map((item) => (
          <div className="alarm" key={`${item.local ? 'local' : 'server'}:${item.code}`}>
            <div className={`alarm-bar ${item.level === 'WARNING' ? 'warning' : 'error'}`} />
            <div className="alarm-main">
              <div className="alarm-title">
                {item.name}
                <span className={`alarm-level ${item.level === 'WARNING' ? 'warning' : 'error'}`}>
                  {item.level === 'WARNING' ? '警告' : '错误'}
                </span>
              </div>
              {item.detail && <div className="alarm-detail">{item.detail}</div>}
              <div className="alarm-meta">
                <span>{formatAlarmTime(item.time)}</span>
                <code>{item.code}</code>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
