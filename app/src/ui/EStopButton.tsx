/**
 * 急停（需求 8.1；前端UI设计 4.2）：始终可按，不确认，可以重复按；按下即发送，不等抬起。
 * 独立组件，直接调用急停通道。
 */
import { Icon } from './Icon.tsx'
import { useRuntime } from './runtimeContext.ts'

export function EStopButton() {
  const { commands } = useRuntime()
  return (
    <>
      <div className="estop-area">
        <button
          type="button"
          className="estop"
          data-testid="btn-estop"
          onPointerDown={() => void commands.estop()}
          onClick={(event) => {
            // 键盘和辅助功能触发的点击没有对应的 pointerdown（detail 为 0）
            if (event.detail === 0) void commands.estop()
          }}
        >
          <Icon name="estop" />
          急停
        </button>
      </div>
      <div className="estop-caption">软件急停不能替代设备急停</div>
    </>
  )
}
