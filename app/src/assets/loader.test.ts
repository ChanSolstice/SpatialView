import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAppStore, type AppStore } from '../store/store.ts'
import { stateForPhase } from '../testing/fixtures.ts'
import { buildGlb, gridSurface } from '../testing/glb.ts'
import { fileUrl, installModelLoader } from './loader.ts'

const BASE = 'http://server:8080'
const glbFor = (id: string) =>
  buildGlb([gridSurface('s1', 0, 0), gridSurface('s2', 0.2, 0)], { model_id: id })

interface Request {
  url: string
  signal: AbortSignal | null | undefined
  respond(body: ArrayBuffer | null, status?: number): void
  fail(error: Error): void
}

let store: AppStore
let requests: Request[]
let uninstall: () => void

/** 假的 fetch：每个请求由测试决定何时、如何回复。 */
const fakeFetch = ((input: RequestInfo | URL, init?: RequestInit) =>
  new Promise<Response>((resolve, reject) => {
    const signal = init?.signal
    signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    requests.push({
      url: String(input),
      signal,
      respond: (body, status = 200) => resolve(new Response(body, { status })),
      fail: reject,
    })
  })) as typeof fetch

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
const model = () => store.getState().model

function serve(modelId: string, phase: 'MODEL_READY' | 'NO_MODEL' = 'MODEL_READY', seq = 1) {
  store.getState().setServer(
    stateForPhase(phase, {
      seq,
      model_id: modelId,
      model_url: modelId ? `/models/${modelId}.glb` : '',
    }),
    { sessionId: 'session-a', seq },
  )
}

beforeEach(() => {
  requests = []
  store = createAppStore({
    conn: { status: 'connected', socketOpen: true, sessionId: null, seq: 0 },
  })
  uninstall = installModelLoader(store, BASE, fakeFetch)
})

afterEach(() => uninstall())

describe('fileUrl', () => {
  it('拼接时两边的斜杠只保留一个', () => {
    expect(fileUrl('http://h:8080', '/models/a.glb')).toBe('http://h:8080/models/a.glb')
    expect(fileUrl('http://h:8080/', 'models/a.glb')).toBe('http://h:8080/models/a.glb')
    expect(fileUrl('http://h/files//', '//models/a.glb')).toBe('http://h/files/models/a.glb')
  })
})

describe('installModelLoader（架构设计 5.6）', () => {
  it('model_id 与本地不同时下载并解析', async () => {
    serve('model_a')
    expect(model()).toMatchObject({ id: 'model_a', status: 'loading', data: null })
    expect(requests.map((r) => r.url)).toEqual([`${BASE}/models/model_a.glb`])
    requests[0]?.respond(glbFor('model_a'))
    await flush()
    expect(model().status).toBe('ready')
    expect(model().data?.surfaces.size).toBe(2)
  })

  it('同一个 model_id 不重复下载', async () => {
    serve('model_a')
    serve('model_a', 'MODEL_READY', 2)
    expect(requests).toHaveLength(1)
  })

  it('新模型准备好之前保留旧模型，替换后释放旧模型', async () => {
    serve('model_a')
    requests[0]?.respond(glbFor('model_a'))
    await flush()
    const old = model().data
    let disposed = false
    old?.surfaces.get('s1')?.mesh.geometry.addEventListener('dispose', () => (disposed = true))

    serve('model_b', 'MODEL_READY', 2)
    expect(model()).toMatchObject({ id: 'model_b', status: 'loading', data: old })
    requests[1]?.respond(glbFor('model_b'))
    await flush()
    expect(model()).toMatchObject({ id: 'model_b', status: 'ready' })
    expect(model().data).not.toBe(old)
    expect(disposed).toBe(true)
  })

  it('加载期间 model_id 又变了：中止旧的下载，只用新的', async () => {
    serve('model_a')
    serve('model_b', 'MODEL_READY', 2)
    expect(requests[0]?.signal?.aborted).toBe(true)
    requests[1]?.respond(glbFor('model_b'))
    await flush()
    expect(model()).toMatchObject({ id: 'model_b', status: 'ready' })
  })

  it('model_id 为空时清除模型', async () => {
    serve('model_a')
    requests[0]?.respond(glbFor('model_a'))
    await flush()
    serve('', 'NO_MODEL', 2)
    expect(model()).toEqual({ id: null, status: 'idle', data: null, error: null })
  })

  it.each([
    ['HTTP 错误', (r: Request) => r.respond(null, 404), 'HTTP 404'],
    ['网络错误', (r: Request) => r.fail(new TypeError('Failed to fetch')), 'Failed to fetch'],
    ['文件与状态不一致', (r: Request) => r.respond(glbFor('model_old')), 'model_id'],
  ])('%s：记录原因，清除场景中的模型', async (_, act, message) => {
    serve('model_a')
    act(requests[0] as Request)
    await flush()
    expect(model()).toMatchObject({ id: 'model_a', status: 'error', data: null })
    expect(model().error).toContain(message)
  })

  it('加载失败后，重新连接时重新下载', async () => {
    serve('model_a')
    requests[0]?.respond(null, 500)
    await flush()
    store.getState().setConn({ status: 'reconnecting' })
    store.getState().setConn({ status: 'connecting' })
    expect(requests).toHaveLength(1)
    store.getState().setConn({ status: 'connected' })
    expect(requests).toHaveLength(2)
    requests[1]?.respond(glbFor('model_a'))
    await flush()
    expect(model().status).toBe('ready')
  })

  it('断线期间不加载：server 保留最后收到的状态', () => {
    store.getState().setConn({ status: 'reconnecting' })
    expect(requests).toHaveLength(0)
  })
})
