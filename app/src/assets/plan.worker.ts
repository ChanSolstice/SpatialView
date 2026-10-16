/**
 * 规划文件的下载和解析（架构设计 5.6）：在 Worker 中完成，解析 15–20 MB 的 JSON 时界面不卡顿；
 * 结果中的类型化数组以可转移对象交回主线程。每次加载新建一个 Worker，完成或中止后结束。
 */
import { fetchPlan, planBuffers, type PlanReply, type PlanRequest } from './plan.ts'

self.onmessage = (event: MessageEvent<PlanRequest>) => {
  void fetchPlan(event.data, fetch).then(
    (result) => {
      const reply: PlanReply = { ok: true, ...result }
      self.postMessage(reply, { transfer: planBuffers(result.data) })
    },
    (error: unknown) => {
      const reply: PlanReply = {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }
      self.postMessage(reply)
    },
  )
}
