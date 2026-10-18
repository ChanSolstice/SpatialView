/**
 * 按服务端状态加载规划（架构设计 5.6），规则与工件模型相同（loader.ts）。
 * 下载和解析在 Worker 中进行，主线程只创建路径的三维对象。
 */
import type { AppStore } from '../store/store.ts'
import { fileUrl, followAsset, mark, measure, MEASURE_PREFIX } from './loader.ts'
import { buildPath, type LoadedPlan } from './path.ts'
import {
  fetchPlan,
  PlanError,
  type PlanReply,
  type PlanRequest,
  type PlanResult,
  type PlanWorkerMessage,
} from './plan.ts'

export type LoadPlan = (request: PlanRequest, signal: AbortSignal) => Promise<PlanResult>

/** 规划文件下载完成的时刻；三维场景在路径第一次绘制后以它为起点记录 plan-display。 */
export const PLAN_DOWNLOADED_MARK = `${MEASURE_PREFIX}plan-downloaded`

/**
 * 在 Worker 中下载和解析。Worker 常驻，第一次加载时创建，各次加载共用，按请求编号对应结果；
 * 中止时通知 Worker 中止下载，之后到达的结果丢弃。
 *
 * 不为每次加载新建、用完即结束 Worker：在 Chrome 中，模块 Worker 跨域读取 gzip 压缩的大文件后立即结束时，
 * response.text() 得到的整份文本（大样例约 17 MB）偶尔不会释放，8 小时测试中渲染进程的内存因此持续增长
 * （阶段规划 4.3）。
 */
export function createWorkerLoadPlan(
  createWorker: () => Worker = () =>
    new Worker(new URL('./plan.worker.ts', import.meta.url), { type: 'module' }),
): LoadPlan {
  let worker: Worker | null = null
  let nextId = 0
  const pending = new Map<
    number,
    { resolve(result: PlanResult): void; reject(error: unknown): void }
  >()

  function start(): Worker {
    const created = createWorker()
    created.onmessage = (event: MessageEvent<PlanReply>) => {
      const reply = event.data
      const entry = pending.get(reply.id)
      if (!entry) return
      pending.delete(reply.id)
      if (reply.ok) entry.resolve(reply)
      else entry.reject(new PlanError(reply.error))
    }
    // Worker 本身出错（例如脚本加载失败）：进行中的加载全部失败，下次加载时重新创建
    created.onerror = (event) => {
      created.terminate()
      if (worker === created) worker = null
      for (const entry of pending.values()) {
        entry.reject(new PlanError(`规划文件解析失败：${event.message}`))
      }
      pending.clear()
    }
    return created
  }

  return (request, signal) =>
    new Promise((resolve, reject) => {
      if (signal.aborted) return reject(new DOMException('已中止', 'AbortError'))
      const id = ++nextId
      const target = (worker ??= start())
      const abort = () => {
        if (!pending.delete(id)) return
        target.postMessage({ type: 'abort', id } satisfies PlanWorkerMessage)
        reject(new DOMException('已中止', 'AbortError'))
      }
      signal.addEventListener('abort', abort, { once: true })
      const settle =
        <T>(finish: (value: T) => void) =>
        (value: T) => {
          signal.removeEventListener('abort', abort)
          finish(value)
        }
      pending.set(id, { resolve: settle(resolve), reject: settle(reject) })
      target.postMessage({ type: 'load', id, request } satisfies PlanWorkerMessage)
    })
}

/** APP 使用的加载函数，第一次加载规划时才创建 Worker。 */
export const workerLoadPlan: LoadPlan = createWorkerLoadPlan()

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
