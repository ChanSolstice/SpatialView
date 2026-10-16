/**
 * 按服务端状态加载、替换或清除工件模型和规划（需求 7.1 第 4 步；架构设计 5.6）。两者的规则相同：
 *
 * - ID 与本地的不同：下载并解析；新的准备好之后才替换旧的，替换后释放旧的。
 * - 加载期间 ID 又变了：中止旧的下载；完成时 ID 已不是当前值的结果直接丢弃。
 * - 加载失败：清除场景中的旧资源，记录原因（本地告警"模型加载失败""规划加载失败"）；重新连接后自动重新下载。
 * - ID 为空：清除。
 */
import type { SystemState } from '../ros/contract.ts'
import type { AppState, AppStore, AssetSlot } from '../store/store.ts'
import { ModelError, parseModel, type LoadedModel } from './model.ts'

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
export function measure(name: string, start: number | string, end = performance.now()): void {
  try {
    performance.clearMeasures(`${MEASURE_PREFIX}${name}`)
    performance.measure(`${MEASURE_PREFIX}${name}`, { start, end })
  } catch {
    // 不支持 User Timing，或起点的 mark 不存在时忽略
  }
}

/** 记录一个时刻，同名的只保留最近一次。 */
export function mark(name: string, startTime = performance.now()): void {
  try {
    performance.clearMarks(name)
    performance.mark(name, { startTime })
  } catch {
    // 不支持 User Timing 时忽略
  }
}

/** 一类随服务端状态加载的资源。 */
export interface AssetKind<T extends { dispose(): void }> {
  /** SystemState 中的 ID 和文件的相对路径；ID 为空表示没有 */
  source(server: SystemState): { id: string; url: string }
  slot(s: AppState): AssetSlot<T>
  update(store: AppStore, patch: Partial<AssetSlot<T>>): void
  /** 下载、解析和校验，失败时抛出错误 */
  load(id: string, url: string, server: SystemState, signal: AbortSignal): Promise<T>
  /** 失败原因的文字 */
  describe(error: unknown): string
}

export function followAsset<T extends { dispose(): void }>(
  store: AppStore,
  kind: AssetKind<T>,
): () => void {
  let controller: AbortController | null = null
  const slot = () => kind.slot(store.getState())

  async function load(id: string, url: string, server: SystemState): Promise<void> {
    controller?.abort()
    const current = new AbortController()
    controller = current
    kind.update(store, { id, status: 'loading', error: null })
    try {
      const data = await kind.load(id, url, server, current.signal)
      if (current.signal.aborted || slot().id !== id) {
        data.dispose()
        return
      }
      const old = slot().data
      kind.update(store, { status: 'ready', data })
      old?.dispose()
    } catch (error) {
      if (current.signal.aborted) return
      const old = slot().data
      kind.update(store, { status: 'error', data: null, error: kind.describe(error) })
      old?.dispose()
    }
  }

  function clear(): void {
    controller?.abort()
    controller = null
    const { id, data } = slot()
    if (id === null && data === null) return
    kind.update(store, { id: null, status: 'idle', data: null, error: null })
    data?.dispose()
  }

  function sync(): void {
    const server = store.getState().server
    // 断线期间不更新：server 保留最后收到的状态
    if (server === null) return
    const { id, url } = kind.source(server)
    if (id === '') return clear()
    if (id !== slot().id) void load(id, url, server)
  }

  sync()
  const unsubscribe = store.subscribe((s, prev) => {
    const id = s.server && kind.source(s.server).id
    if (id !== (prev.server && kind.source(prev.server).id)) sync()
    // 加载失败后，重新连接（包括点击刷新连接）时重新下载（需求 7.1）
    const reconnected = s.conn.status === 'connected' && prev.conn.status !== 'connected'
    if (reconnected && kind.slot(s).status === 'error' && s.server && id) {
      void load(id, kind.source(s.server).url, s.server)
    }
  })
  return () => {
    unsubscribe()
    controller?.abort()
  }
}

export function installModelLoader(
  store: AppStore,
  httpBaseUrl: string,
  fetchFile: typeof fetch = (input, init) => fetch(input, init),
): () => void {
  return followAsset<LoadedModel>(store, {
    source: (server) => ({ id: server.model_id, url: server.model_url }),
    slot: (s) => s.model,
    update: (target, patch) => target.getState().setModel(patch),
    load: async (id, url, _server, signal) => {
      const started = performance.now()
      const response = await fetchFile(fileUrl(httpBaseUrl, url), { signal })
      if (!response.ok) throw new ModelError(`下载失败：HTTP ${response.status}`)
      const data = await response.arrayBuffer()
      measure('model-download', started)
      mark(MODEL_DOWNLOADED_MARK)
      const parsing = performance.now()
      const model = await parseModel(data, id)
      measure('model-parse', parsing)
      return model
    },
    describe: (error) =>
      error instanceof ModelError
        ? error.message
        : `下载失败：${error instanceof Error ? error.message : String(error)}`,
  })
}
