/**
 * 三维区（需求 6.3；前端UI设计 4.3）。三维场景在阶段 7 加入；这里先给出中央提示：
 * 无模型时的"暂无模型"，服务端耗时阶段的进度卡片。断线期间保留最后的画面。
 */
import { PROGRESS_TEXT, progressPercent, sceneContent } from '../domain/phase.ts'
import type { Phase } from '../ros/contract.ts'
import { Icon } from './Icon.tsx'
import { useApp } from './runtimeContext.ts'
import { ToastHost } from './ToastHost.tsx'
import './SceneArea.css'

function Center() {
  const server = useApp((s) => s.server)
  const mode = useApp((s) => s.mode)
  const content = sceneContent(server?.phase ?? null, mode)

  if (content.center === 'empty') {
    return (
      <div className="scene-center">
        <div className="scene-empty">
          <Icon name="cube" />
          <div className="scene-empty-title">暂无模型，请开始扫描</div>
          <div className="scene-empty-hint">点击右侧"开始扫描"，完成后在这里显示工件模型</div>
        </div>
      </div>
    )
  }
  if (content.center === 'progress' && server) {
    const percent = progressPercent(server)
    return (
      <div className="scene-center">
        <div className="progress-card" data-testid="progress-card">
          <div className="progress-row">
            <span className="spinner" />
            <span>{PROGRESS_TEXT[server.phase as Phase]}</span>
            {percent !== null && <span className="progress-percent">{percent}%</span>}
          </div>
          {percent !== null && (
            <div className="progress-bar">
              <i style={{ width: `${percent}%` }} />
            </div>
          )}
        </div>
      </div>
    )
  }
  return null
}

export function SceneArea() {
  return (
    <section className="scene" data-testid="scene">
      <Center />
      <ToastHost />
    </section>
  )
}
