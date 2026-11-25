import { describe, expect, it } from 'vitest'
import type { LoadedModel } from '../assets/model.ts'
import { buildPath } from '../assets/path.ts'
import { parsePlan } from '../assets/plan.ts'
import { wrapRobot } from '../assets/robot.ts'
import { INTERFACE_VERSION } from '../ros/contract.ts'
import { stateForPhase, STATE_IDS } from '../testing/fixtures.ts'
import { testPlanJson } from '../testing/plan.ts'
import { testRobotModel } from '../testing/robot.ts'
import { installLocalAlarms, MAX_SURFACES, MAX_TRIANGLES } from './localAlarms.ts'
import { selectAlarmSummary } from './selectors.ts'
import { createAppStore } from './store.ts'

function setup() {
  let now = 1000
  const store = createAppStore({
    conn: { status: 'connected', socketOpen: true, sessionId: 's', seq: 1 },
    server: stateForPhase('PLAN_READY'),
  })
  installLocalAlarms(store, () => now)
  return { store, tick: (ms: number) => (now += ms) }
}
const codes = (store: ReturnType<typeof setup>['store']) =>
  store.getState().localAlarms.map((a) => a.code)

describe('本地告警（需求 7.4、9.1）', () => {
  it('WebSocket 已断开为网络连接断开，连接还在但收不到状态为服务端无响应；恢复后消失', () => {
    const { store, tick } = setup()
    store.getState().setConn({ status: 'reconnecting', socketOpen: false })
    expect(codes(store)).toEqual(['APP_NETWORK_DOWN'])
    tick(500)
    store.getState().setConn({ socketOpen: true })
    expect(store.getState().localAlarms).toEqual([
      { code: 'APP_SERVER_NO_RESPONSE', detail: '', since: 1500 },
    ])
    store.getState().setConn({ status: 'connected' })
    expect(codes(store)).toEqual([])
  })

  it('启动时正在连接不算断线', () => {
    const { store } = setup()
    store.getState().setConn({ status: 'connecting', socketOpen: false })
    expect(codes(store)).toEqual([])
  })

  it('模型、规划加载失败：补充说明为原因；重新加载成功后消失', () => {
    const { store } = setup()
    store.getState().setModel({ status: 'error', error: '下载失败：HTTP 404' })
    store.getState().setPlan({ status: 'error', error: '规划文件不是有效的 JSON' })
    expect(store.getState().localAlarms.map((a) => [a.code, a.detail])).toEqual([
      ['APP_MODEL_LOAD_FAILED', '下载失败：HTTP 404'],
      ['APP_PLAN_LOAD_FAILED', '规划文件不是有效的 JSON'],
    ])
    store.getState().setModel({ status: 'ready', error: null })
    expect(codes(store)).toEqual(['APP_PLAN_LOAD_FAILED'])
  })

  it('接口版本不匹配：补充说明给出两边的版本', () => {
    const { store } = setup()
    store.getState().setServer(stateForPhase('PLAN_READY', { interface_version: '2.0' }), {
      sessionId: 's',
      seq: 2,
    })
    expect(store.getState().localAlarms[0]).toMatchObject({
      code: 'APP_INTERFACE_MISMATCH',
      detail: `服务端接口版本 2.0，APP 期望 ${INTERFACE_VERSION}`,
    })
  })

  it('模型超出规模约定（接口文档 10.2）：超过 500 个表面或 30 万三角面时警告，列出数量', () => {
    const { store } = setup()
    const model = (surfaces: number, triangles: number) =>
      ({
        id: STATE_IDS.model,
        surfaces: new Map(Array.from({ length: surfaces }, (_, i) => [`s${i}`, {}])),
        triangles,
      }) as unknown as LoadedModel
    const load = (surfaces: number, triangles: number) =>
      store.getState().setModel({ status: 'ready', data: model(surfaces, triangles) })
    load(MAX_SURFACES, MAX_TRIANGLES)
    expect(codes(store)).toEqual([])
    load(MAX_SURFACES + 1, 1000)
    expect(store.getState().localAlarms[0]).toMatchObject({
      code: 'APP_MODEL_OVERSIZE',
      detail:
        '表面 501 个、三角面 1000 个，约定不超过 500 个表面、300000 个三角面；显示和点选可能变慢',
    })
    load(10, MAX_TRIANGLES + 1)
    expect(codes(store)).toEqual(['APP_MODEL_OVERSIZE'])
    load(10, 1000)
    expect(codes(store)).toEqual([])
  })

  it('规划数据与机械臂模型不匹配：列出对不上的关节；Status Bar 计入本地告警', () => {
    const { store } = setup()
    const ids = { planId: STATE_IDS.plan, modelId: STATE_IDS.model }
    const json = testPlanJson({ ...ids, jointNames: ['J1', 'b', 'c', 'd', 'e', 'f'] })
    store.getState().setPlan({ status: 'ready', data: buildPath(parsePlan(json, ids, 0.05)) })
    store.getState().setRobot({ status: 'ready', data: wrapRobot(testRobotModel(), {}) })
    expect(store.getState().localAlarms[0]?.detail).toBe(
      '规划文件中的关节在机械臂模型中没有：J1，b，c，d，e，f',
    )
    expect(selectAlarmSummary(store.getState())).toEqual({
      count: 1,
      text: '1 个告警',
      tone: 'pause',
    })
  })
})
