/**
 * 操作结果提示框（需求 5.5）：根据 last_result 决定是否弹框、弹什么。
 * 组合见接口文档 8.7；不在其中的组合按 result 给出通用标题，不漏报失败和中断。
 */
import type { OperationResult } from '../ros/contract.ts'
import { resultCodeText } from './codes.ts'

/** 图标与颜色（前端UI设计 4.4）：失败或中断为红，部分完成为琥珀，完成为绿。 */
export type ResultTone = 'error' | 'partial' | 'success'

export interface ResultNotice {
  title: string
  tone: ResultTone
  /** APP 按原因码给出的原因；为空时只显示补充说明。 */
  reason: string
  detail: string
  code: string
  /** 清洗中断：阶段为已暂停时加一行继续或停止的操作提示，见 resultHint。 */
  resumable: boolean
}

/** 清洗中断后停在已暂停时的操作提示（需求 5.5；接口文档 6.5"中断后继续"）。 */
export const RESUME_HINT = '排除故障后点击"继续"，从中断处接着清洗；或点击"停止"结束本次清洗。'

/**
 * 结果提示框中的操作提示，按当前阶段给出：提示框打开期间任务被停止、继续时随之变化，
 * 不提示已经不能按的按钮。停止中被中断的清洗回到规划就绪，没有这一行。
 */
export function resultHint(notice: ResultNotice, phase: string | undefined): string {
  return notice.resumable && phase === 'PAUSED' ? RESUME_HINT : ''
}

const FAILED_TITLE = new Map([
  ['SCAN', '扫描失败'],
  ['RECONSTRUCT', '重建失败'],
  ['PLAN', '规划失败'],
  ['TASK', '清洗失败'],
  ['POWER_ON', '上电失败'],
])

const INTERRUPTED_TITLE = new Map([
  ['SCAN', '扫描已中断'],
  ['RECONSTRUCT', '重建已中断'],
  ['PLAN', '规划已中断'],
  ['TASK', '清洗已中断'],
])

/**
 * 需要提示的结果。扫描成功、重建成功、全部表面规划成功、用户主动停止不弹框，画面变化本身就是反馈。
 */
export function resultNotice(result: OperationResult): ResultNotice | null {
  const { operation, code, detail } = result
  const notice = (title: string, tone: ResultTone): ResultNotice => ({
    title,
    tone,
    reason: resultCodeText(code),
    detail,
    code,
    resumable: operation === 'TASK' && result.result === 'INTERRUPTED',
  })
  switch (result.result) {
    case 'FAILED':
      return notice(FAILED_TITLE.get(operation) ?? '操作失败', 'error')
    case 'INTERRUPTED':
      return notice(INTERRUPTED_TITLE.get(operation) ?? '操作已中断', 'error')
    case 'SUCCEEDED':
      if (operation === 'TASK') return notice('清洗完成', 'success')
      if (operation === 'PLAN' && code === 'PLAN_PARTIAL')
        return notice('部分表面未能规划', 'partial')
      return null
    default:
      return null
  }
}

/**
 * 按 last_result.id 判断是否弹框（需求 5.5）。lastResultId 为 null 表示 APP 启动后还没有收到过状态：
 * 第一份状态只记录 id、不弹框；之后 id 变化即弹框。id 为空表示本会话还没有结果。
 */
export function nextResult(
  lastResultId: string | null,
  result: OperationResult,
): { id: string; notice: ResultNotice | null } {
  if (lastResultId === null || result.id === lastResultId || result.id === '') {
    return { id: result.id, notice: null }
  }
  return { id: result.id, notice: resultNotice(result) }
}
