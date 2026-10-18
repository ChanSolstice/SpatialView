/**
 * 规划文件的下载和解析（架构设计 5.6）：在 Worker 中完成，解析 15–20 MB 的 JSON 时界面不卡顿；
 * 结果中的类型化数组以可转移对象交回主线程。Worker 常驻，各次加载共用，按请求编号回复（planLoader.ts）。
 */
import { fetchPlan, planBuffers, type PlanReply, type PlanWorkerMessage } from './plan.ts'

/** 进行中的加载。中止时删除，之后完成的结果不再回复 */
const loads = new Map<number, AbortController>()

self.onmessage = (event: MessageEvent<PlanWorkerMessage>) => {
  const message = event.data
  if (message.type === 'abort') {
    loads.get(message.id)?.abort()
    loads.delete(message.id)
    return
  }
  const { id, request } = message
  const controller = new AbortController()
  loads.set(id, controller)
  void fetchPlan(request, fetch, controller.signal).then(
    (result) => {
      if (!loads.delete(id)) return
      const reply: PlanReply = { id, ok: true, ...result }
      self.postMessage(reply, { transfer: planBuffers(result.data) })
    },
    (error: unknown) => {
      if (!loads.delete(id)) return
      const reply: PlanReply = {
        id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }
      self.postMessage(reply)
    },
  )
}
