/** Status Bar（需求 5.2；前端UI设计 4.1）。未连接时机械臂、作业、激光、相机都显示"未知"。 */
import {
  cameraView,
  laserView,
  phaseView,
  robotView,
  SERVICE_VIEW,
  type StatusView,
} from '../domain/phase.ts'
import { liveState, selectAlarmSummary } from '../store/selectors.ts'
import { Icon } from './Icon.tsx'
import { useApp, useRuntime } from './runtimeContext.ts'
import './StatusBar.css'

function Pill({ view, className }: { view: StatusView; className?: string }) {
  return <span className={`pill ${view.tone}${className ? ` ${className}` : ''}`}>{view.text}</span>
}

export function StatusBar() {
  const { connection, store } = useRuntime()
  const state = useApp(liveState)
  const status = useApp((s) => s.conn.status)
  const alarms = useApp(selectAlarmSummary)
  const panelOpen = useApp((s) => s.alarmPanelOpen)
  const phase = phaseView(state)

  return (
    <header className="sb">
      <div className="sb-brand">
        <span className="sb-mark">
          <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 17l5-6 4 3 7-8" />
          </svg>
        </span>
        SpatialView
      </div>
      <div className="sb-item" data-testid="sb-robot">
        <span className="sb-label">机械臂</span>
        <Pill view={robotView(state)} className="is-robot" />
      </div>
      <div className="sb-item" data-testid="sb-phase">
        <span className="sb-label">作业</span>
        <span className={phase.known ? 'sb-phase' : 'sb-phase is-unknown'}>{phase.text}</span>
      </div>
      <div className="sb-item" data-testid="sb-laser">
        <span className="sb-label">激光</span>
        <Pill view={laserView(state)} />
      </div>
      <div className="sb-item" data-testid="sb-camera">
        <span className="sb-label">相机</span>
        <Pill view={cameraView(state)} />
      </div>
      <div className="sb-item" data-testid="sb-service">
        <span className="sb-label">服务</span>
        <Pill view={SERVICE_VIEW[status]} />
        <button type="button" className="sb-button" onClick={() => connection.refresh(true)}>
          <Icon name="refresh" />
          刷新连接
        </button>
      </div>
      <div className="sb-spacer" />
      <button
        type="button"
        className={[
          'sb-alarm',
          alarms.tone === 'none' ? '' : alarms.tone,
          panelOpen ? 'is-open' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        data-testid="sb-alarm"
        aria-expanded={panelOpen}
        onClick={() => store.getState().setAlarmPanel(!panelOpen)}
      >
        <Icon name="bell" />
        <span>{alarms.text}</span>
        <Icon name={panelOpen ? 'up' : 'down'} />
      </button>
    </header>
  )
}
