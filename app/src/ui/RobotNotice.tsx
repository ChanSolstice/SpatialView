/**
 * 机械臂提示（需求 5.6；前端UI设计 4.8）：机械臂急停或未启动时显示在三维区顶部，说明原因和下一步；
 * 随机械臂状态出现和消失，不能手动关闭。软件急停时可以复位，复位需要确认（需求 5.4）。
 */
import { confirmation } from '../domain/availability.ts'
import { robotNotice } from '../domain/phase.ts'
import { liveState, selectAvailability } from '../store/selectors.ts'
import { Icon } from './Icon.tsx'
import { useApp, useRuntime } from './runtimeContext.ts'
import './RobotNotice.css'

export function RobotNotice() {
  const { store } = useRuntime()
  // 未连接时机械臂状态未知（需求 5.2），不显示提示
  const notice = useApp((s) => robotNotice(liveState(s)))
  const { reset } = useApp(selectAvailability)
  if (!notice) return null

  const estop = notice.kind !== 'disabled'
  const press = () => {
    const s = store.getState()
    if (!selectAvailability(s).reset.enabled) return
    s.pushDialog({
      kind: 'confirm',
      action: 'resetEstop',
      confirmation: confirmation('resetEstop', s.server, s.selection.size),
    })
  }
  return (
    <div
      className={`robot-notice ${estop ? 'is-estop' : 'is-off'}`}
      role="status"
      data-testid="robot-notice"
    >
      <Icon name={estop ? 'estop' : 'power'} />
      <div className="robot-notice-text">
        <div className="robot-notice-title">{notice.title}</div>
        <div className="robot-notice-detail">{notice.text}</div>
      </div>
      {notice.reset && (
        <button
          type="button"
          className="robot-notice-reset"
          disabled={!reset.enabled}
          onClick={press}
        >
          {reset.busy && <span className="spinner" />}
          复位急停
        </button>
      )}
    </div>
  )
}
