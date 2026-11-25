/**
 * 跟随服务端状态自动进行的界面变化，集中在 store 监听中完成，不散落在组件里（架构设计 5.2）：
 * 场景模式的自动退出、模型变化时清空选择、确认对话框在操作不可用时自动关闭、规划加载后说明规划范围。
 */
import { isActionAvailable } from '../domain/availability.ts'
import { EXPANDED_TITLE, planRange, rangeLines } from '../domain/planRange.ts'
import { selectAvailability } from './selectors.ts'
import type { AppStore } from './store.ts'

const SELECT_PHASES: ReadonlySet<string> = new Set(['MODEL_READY', 'PLAN_READY'])

export function installListeners(store: AppStore): () => void {
  return store.subscribe((s, prev) => {
    // 阶段离开模型就绪、规划就绪时退出选面；离开规划就绪时退出轨迹动画（需求 6.4、6.6）。
    // server 只在取得服务端状态时更新，断线本身不会退出
    const phase = s.server?.phase ?? ''
    if (phase !== (prev.server?.phase ?? '')) {
      if (s.mode === 'select' && !SELECT_PHASES.has(phase)) s.setMode('browse')
      if (s.mode === 'animate' && phase !== 'PLAN_READY') s.setMode('browse')
    }

    // 模型 ID 变化时清空选择（需求 6.4）
    if ((s.server?.model_id ?? '') !== (prev.server?.model_id ?? '') && s.selectionBasis !== null) {
      s.setSelection(new Set(), null)
    }

    // 规划加载后说明规划范围（需求 5.5）：部分路径未能规划的提示框还在时由它显示说明（DialogHost），
    // 否则有扩展时单独弹出信息提示框。加载失败时不说明
    const pending = s.planNotice
    if (pending !== null && s.plan !== prev.plan && s.plan.id === pending) {
      const loaded = s.plan.data?.id === pending ? s.plan.data : null
      if (loaded !== null || s.plan.status === 'error') {
        s.setPlanNotice(null)
        const range = loaded && planRange(loaded.data.scope, loaded.data.surfaceIds)
        const shown = s.dialogs.some((d) => d.kind === 'result' && d.notice.planId === pending)
        if (range && range.expanded.size > 0 && !shown) {
          s.pushDialog({ kind: 'info', title: EXPANDED_TITLE, text: rangeLines(range).join('') })
        }
      }
    }

    // 对话框打开期间，对应操作因状态变化已不可用时，自动关闭，不发送指令（需求 5.4）
    const confirms = s.dialogs.filter((d) => d.kind === 'confirm')
    if (confirms.length > 0) {
      const result = selectAvailability(s)
      for (const dialog of confirms) {
        if (!isActionAvailable(dialog.action, result)) s.closeDialog(dialog.id)
      }
    }
  })
}
