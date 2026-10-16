/**
 * 三维区（需求 6.3；前端UI设计 4.3）：三维场景和全部浮层。断线期间保留最后的画面。
 * 中央提示：无模型时的"暂无模型"，服务端耗时阶段的进度卡片，本地加载模型、规划时的加载卡片。
 */
import { lazy, Suspense } from 'react'
import { PROGRESS_TEXT, progressPercent, sceneContent } from '../domain/phase.ts'
import type { Phase } from '../ros/contract.ts'
import { Icon } from './Icon.tsx'
import { useApp, useRuntime } from './runtimeContext.ts'
import { ToastHost } from './ToastHost.tsx'
import './SceneArea.css'

// react-three-fiber 和 drei 只在三维区使用，单独打包；three.js 在启动时由模型加载使用，留在主包
const SceneCanvas = lazy(() =>
  import('../scene/SceneCanvas.tsx').then((m) => ({ default: m.SceneCanvas })),
)

function ProgressCard({ text, percent }: { text: string; percent: number | null }) {
  return (
    <div className="scene-center">
      <div className="progress-card" data-testid="progress-card">
        <div className="progress-row">
          <span className="spinner" />
          <span>{text}</span>
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

function Center() {
  const server = useApp((s) => s.server)
  const mode = useApp((s) => s.mode)
  const modelLoading = useApp((s) => s.model.status === 'loading')
  const content = sceneContent(server?.phase ?? null, mode)

  if (content.center === 'progress' && server) {
    return (
      <ProgressCard
        text={PROGRESS_TEXT[server.phase as Phase] ?? ''}
        percent={progressPercent(server)}
      />
    )
  }
  // 本地加载使用同一张卡片，不显示百分比（前端UI设计 4.3）
  if (modelLoading) return <ProgressCard text="正在加载模型…" percent={null} />
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
  return null
}

/** 选面工具条（需求 6.4）：已选 N 个表面 ｜ 清空选择 ｜ 退出选面。 */
function SelectionToolbar() {
  const { store } = useRuntime()
  const selecting = useApp((s) => s.mode === 'select')
  const count = useApp((s) => s.selection.size)
  if (!selecting) return null
  return (
    <div className="toolbar" data-testid="selection-toolbar">
      <span className="toolbar-count">已选 {count} 个表面</span>
      <button
        type="button"
        className="tool-button"
        onClick={() => store.getState().setSelection(new Set())}
      >
        <Icon name="clear" />
        清空选择
      </button>
      <button
        type="button"
        className="tool-button"
        onClick={() => store.getState().setMode('browse')}
      >
        <Icon name="close" />
        退出选面
      </button>
    </div>
  )
}

export function SceneArea() {
  const { store } = useRuntime()
  return (
    <section className="scene" data-testid="scene">
      <div className="scene-canvas">
        <Suspense fallback={null}>
          <SceneCanvas />
        </Suspense>
      </div>
      <button type="button" className="view-reset" onClick={() => store.getState().resetView()}>
        <Icon name="view" />
        恢复默认视角
      </button>
      <Center />
      <div className="scene-top">
        <SelectionToolbar />
        <ToastHost />
      </div>
    </section>
  )
}
