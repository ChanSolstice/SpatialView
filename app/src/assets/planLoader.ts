/**
 * 按服务端状态加载规划（架构设计 5.6），规则与工件模型相同（loader.ts）。
 * 下载和解析在 Worker 中进行，主线程只创建路径的三维对象。
 */
import type { AppStore } from '../store/store.ts'
import { fileUrl, followAsset, mark, measure, MEASURE_PREFIX } from './loader.ts'
import { buildPath, type LoadedPlan } from './path.ts'
import { fetchPlan, PlanError, type PlanReply, type PlanRequest, type PlanResult } from './plan.ts'

export type LoadPlan = (request: PlanRequest, signal: AbortSignal) => Promise<PlanResult>

/** 规划文件下载完成的时刻；三维场景在路径第一次绘制后以它为起点记录 plan-display。 */
export const PLAN_DOWNLOADED_MARK = `${MEASURE_PREFIX}plan-downloaded`

/** 在 Worker 中下载和解析，每次加载一个 Worker，完成或中止后结束。 */
export const workerLoadPlan: LoadPlan = (request, signal) =>
  new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./plan.worker.ts', import.meta.url), { type: 'module' })
    const abort = () => {
      worker.terminate()
      reject(new DOMException('已中止', 'AbortError'))
    }
    const done = () => {
      signal.removeEventListener('abort', abort)
      worker.terminate()
    }
    signal.addEventListener('abort', abort, { once: true })
    worker.onmessage = (event: MessageEvent<PlanReply>) => {
      done()
      const reply = event.data
      if (reply.ok) resolve(reply)
      else reject(new PlanError(reply.error))
    }
    worker.onerror = (event) => {
      done()
      reject(new PlanError(`规划文件解析失败：${event.message}`))
    }
    worker.postMessage(request)
  })

/** 在主线程中下载和解析（测试中使用）。 */
export function inThreadLoadPlan(fetchFile: typeof fetch): LoadPlan {
  return (request, signal) => fetchPlan(request, fetchFile, signal)
}

export function installPlanLoader(
  store: AppStore,
  httpBaseUrl: string,
  arrowSpacing: number,
  loadPlan: LoadPlan = workerLoadPlan,
): () => void {
  return followAsset<LoadedPlan>(store, {
    source: (server) => ({ id: server.plan_id, url: server.plan_url }),
    slot: (s) => s.plan,
    update: (target, patch) => target.getState().setPlan(patch),
    load: async (id, url, server, signal) => {
      const result = await loadPlan(
        { url: fileUrl(httpBaseUrl, url), planId: id, modelId: server.model_id, arrowSpacing },
        signal,
      )
      // Worker 中的时刻换算到主线程的时间轴
      const downloaded = result.downloadedAt - performance.timeOrigin
      measure('plan-download', downloaded - result.downloadMs, downloaded)
      measure('plan-parse', downloaded, downloaded + result.parseMs)
      mark(PLAN_DOWNLOADED_MARK, downloaded)
      return buildPath(result.data)
    },
    describe: (error) =>
      error instanceof PlanError
        ? error.message
        : `规划文件加载失败：${error instanceof Error ? error.message : String(error)}`,
  })
}
