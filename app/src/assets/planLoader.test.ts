import type { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAppStore, type AppStore } from '../store/store.ts'
import { stateForPhase, STATE_IDS } from '../testing/fixtures.ts'
import { testPlanJson } from '../testing/plan.ts'
import { installPlanLoader, type LoadPlan } from './planLoader.ts'
import { fetchPlan, type PlanRequest } from './plan.ts'

const BASE = 'http://server:8080'

interface Pending {
  request: PlanRequest
  signal: AbortSignal
  /** 用给定的规划文件内容完成加载 */
  respond(json: unknown): void
  fail(status: number): void
}

let store: AppStore
let pending: Pending[]
let uninstall: () => void

/** 每次加载由测试决定何时、以什么内容完成；解析走真实的 fetchPlan。 */
const fakeLoad: LoadPlan = (request, signal) =>
  new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    const finish = (response: Response) =>
      fetchPlan(request, (() => Promise.resolve(response)) as typeof fetch, signal).then(
        resolve,
        reject,
      )
    pending.push({
      request,
      signal,
      respond: (json) => void finish(new Response(JSON.stringify(json))),
      fail: (status) => void finish(new Response(null, { status })),
    })
  })

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
const plan = () => store.getState().plan
const json = (planId: string, modelId = STATE_IDS.model) => testPlanJson({ planId, modelId })

function serve(planId: string, seq = 1) {
  store.getState().setServer(
    stateForPhase(planId ? 'PLAN_READY' : 'MODEL_READY', {
      seq,
      plan_id: planId,
      plan_url: planId ? `/plans/${planId}.json` : '',
    }),
    { sessionId: 'session-a', seq },
  )
}

beforeEach(() => {
  pending = []
  store = createAppStore({
    conn: { status: 'connected', socketOpen: true, sessionId: null, seq: 0 },
  })
  uninstall = installPlanLoader(store, BASE, 0.05, fakeLoad)
})

afterEach(() => uninstall())

describe('installPlanLoader（架构设计 5.6）', () => {
  it('plan_id 与本地不同时下载并解析，请求中带上期望的 ID 和箭头间距', async () => {
    serve('plan_a')
    expect(plan()).toMatchObject({ id: 'plan_a', status: 'loading', data: null })
    expect(pending[0]?.request).toEqual({
      url: `${BASE}/plans/plan_a.json`,
      planId: 'plan_a',
      modelId: STATE_IDS.model,
      arrowSpacing: 0.05,
    })
    pending[0]?.respond(json('plan_a'))
    await flush()
    expect(plan().status).toBe('ready')
    expect(plan().data?.data.duration).toBe(10)
  })

  it('新规划准备好之前保留旧规划，替换后释放旧规划', async () => {
    serve('plan_a')
    pending[0]?.respond(json('plan_a'))
    await flush()
    const old = plan().data
    let disposed = false
    const process = old?.group.getObjectByName('process') as LineSegments2 | undefined
    process?.geometry.addEventListener('dispose', () => (disposed = true))

    serve('plan_b', 2)
    expect(plan()).toMatchObject({ id: 'plan_b', status: 'loading', data: old })
    pending[1]?.respond(json('plan_b'))
    await flush()
    expect(plan()).toMatchObject({ id: 'plan_b', status: 'ready' })
    expect(disposed).toBe(true)
  })

  it('加载期间 plan_id 又变了：中止旧的加载', async () => {
    serve('plan_a')
    serve('plan_b', 2)
    expect(pending[0]?.signal.aborted).toBe(true)
    pending[1]?.respond(json('plan_b'))
    await flush()
    expect(plan()).toMatchObject({ id: 'plan_b', status: 'ready' })
  })

  it('plan_id 为空时清除规划', async () => {
    serve('plan_a')
    pending[0]?.respond(json('plan_a'))
    await flush()
    serve('', 2)
    expect(plan()).toEqual({ id: null, status: 'idle', data: null, error: null })
  })

  it.each([
    ['HTTP 错误', (p: Pending) => p.fail(404), 'HTTP 404'],
    ['文件与状态不一致', (p: Pending) => p.respond(json('plan_a', 'model_x')), 'model_id'],
    ['不是 JSON 对象', (p: Pending) => p.respond([1, 2]), '不是 JSON 对象'],
  ])('%s：记录原因，清除场景中的规划', async (_, act, message) => {
    serve('plan_a')
    act(pending[0] as Pending)
    await flush()
    expect(plan()).toMatchObject({ id: 'plan_a', status: 'error', data: null })
    expect(plan().error).toContain(message)
  })

  it('加载失败后，重新连接时重新下载', async () => {
    serve('plan_a')
    pending[0]?.fail(500)
    await flush()
    store.getState().setConn({ status: 'reconnecting' })
    store.getState().setConn({ status: 'connected' })
    expect(pending).toHaveLength(2)
    pending[1]?.respond(json('plan_a'))
    await flush()
    expect(plan().status).toBe('ready')
  })
})
