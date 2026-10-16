/**
 * 按服务端状态加载、替换或清除工件模型（需求 7.1 第 4 步；架构设计 5.6）。
 *
 * - model_id 与本地的不同：下载并解析；新模型准备好之后才替换旧模型，替换后释放旧模型。
 * - 加载期间 model_id 又变了：中止旧的下载；完成时 ID 已不是当前值的结果直接丢弃。
 * - 加载失败：清除场景中的模型，记录原因（本地告警"模型加载失败"）；重新连接后自动重新下载。
 * - model_id 为空：清除模型。
 */
import type { AppStore } from '../store/store.ts'
import { ModelError, parseModel } from './model.ts'

/** http_base_url 与相对路径拼接，两边多余的斜杠只保留一个。 */
export function fileUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
}

/**
 * 性能测量（需求 12.2）：下载、解析、下载完成到显示的耗时写入 performance 的 measure，名称以此开头，
 * 在平板上用 chrome://inspect 查看。
 */
export const MEASURE_PREFIX = 'spatialview:'
/** 模型下载完成的时刻；三维场景在模型第一次绘制后以它为起点记录 model-display。 */
export const MODEL_DOWNLOADED_MARK = `${MEASURE_PREFIX}model-downloaded`

/** 记录一次耗时；同名的只保留最近一次，长时间运行时不累积。 */
export function measure(name: string, start: number | string): void {
  try {
    performance.clearMeasures(`${MEASURE_PREFIX}${name}`)
    performance.measure(`${MEASURE_PREFIX}${name}`, { start, end: performance.now() })
  } catch {
    // 不支持 User Timing，或起点的 mark 不存在时忽略
  }
}

export function installModelLoader(
  store: AppStore,
  httpBaseUrl: string,
  fetchFile: typeof fetch = (input, init) => fetch(input, init),
): () => void {
  let controller: AbortController | null = null

  async function load(id: string, url: string): Promise<void> {
    controller?.abort()
    const current = new AbortController()
    controller = current
    store.getState().setModel({ id, status: 'loading', error: null })
    const started = performance.now()
    try {
      const response = await fetchFile(fileUrl(httpBaseUrl, url), { signal: current.signal })
      if (!response.ok) throw new ModelError(`下载失败：HTTP ${response.status}`)
      const data = await response.arrayBuffer()
      measure('model-download', started)
      performance.clearMarks(MODEL_DOWNLOADED_MARK)
      performance.mark(MODEL_DOWNLOADED_MARK)
      const parsing = performance.now()
      const model = await parseModel(data, id)
      measure('model-parse', parsing)
      if (current.signal.aborted || store.getState().model.id !== id) {
        model.dispose()
        return
      }
      const old = store.getState().model.data
      store.getState().setModel({ status: 'ready', data: model })
      old?.dispose()
    } catch (error) {
      if (current.signal.aborted) return
      const message =
        error instanceof ModelError
          ? error.message
          : `下载失败：${error instanceof Error ? error.message : String(error)}`
      const old = store.getState().model.data
      store.getState().setModel({ status: 'error', data: null, error: message })
      old?.dispose()
    }
  }

  function clear(): void {
    controller?.abort()
    controller = null
    const { model, setModel } = store.getState()
    if (model.id === null && model.data === null) return
    setModel({ id: null, status: 'idle', data: null, error: null })
    model.data?.dispose()
  }

  function sync(): void {
    const { server, model } = store.getState()
    // 断线期间不更新：server 保留最后收到的状态
    if (server === null) return
    if (server.model_id === '') return clear()
    if (server.model_id !== model.id) void load(server.model_id, server.model_url)
  }

  sync()
  const unsubscribe = store.subscribe((s, prev) => {
    if (s.server?.model_id !== prev.server?.model_id) sync()
    // 加载失败后，重新连接（包括点击刷新连接）时重新下载（需求 7.1）
    const reconnected = s.conn.status === 'connected' && prev.conn.status !== 'connected'
    if (reconnected && s.model.status === 'error' && s.server?.model_id) {
      void load(s.server.model_id, s.server.model_url)
    }
  })
  return () => {
    unsubscribe()
    controller?.abort()
  }
}
