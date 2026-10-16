/**
 * 接口约定测试（架构设计 8.2）：用 APP 的连接实现和 zod 校验规则，对开发环境中的 mock 服务端逐个调用全部接口。
 * 需要正在运行的开发环境（deploy/README.md），设置 SPATIALVIEW_CONTRACT_ROSBRIDGE 后运行：
 *
 *   SPATIALVIEW_CONTRACT_ROSBRIDGE=ws://localhost:9090 npm run test:contract
 *
 * 会让模拟的机械臂运动、开启激光、触发软件急停并复位。不要对真实服务端运行，真实服务端使用接口检查工具。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  COMMAND_CODES,
  commandResponseSchema,
  ESTOP_SERVICE,
  getSystemStateResponseSchema,
  INTERFACE_VERSION,
  isOneOf,
  SERVICES,
  SYSTEM_STATE_TOPIC,
  systemStateSchema,
  triggerResponseSchema,
  unknownValues,
  type CommandResponse,
  type SystemState,
} from '../src/ros/contract.ts'
import { connectRoslib, type RosSocket } from '../src/ros/transport.ts'

const url = process.env.SPATIALVIEW_CONTRACT_ROSBRIDGE
const TIMEOUT_MS = 5000

let socket: RosSocket
let latest: SystemState | null = null
const received: unknown[] = []

async function call(
  service: { name: string; type: string },
  args: object = {},
): Promise<CommandResponse> {
  const response = commandResponseSchema.parse(
    await socket.call(service.name, service.type, args, TIMEOUT_MS),
  )
  expect(isOneOf(COMMAND_CODES, response.code), response.code).toBe(true)
  return response
}

async function accepted(service: { name: string; type: string }, args: object = {}) {
  const response = await call(service, args)
  expect(response.code, `${service.name}：${response.detail}`).toBe('OK')
  return response.state
}

/** 等待 Topic 上出现满足条件的状态。 */
async function until(predicate: (state: SystemState) => boolean, what: string, seconds = 90) {
  const deadline = Date.now() + seconds * 1000
  while (Date.now() < deadline) {
    if (latest && predicate(latest)) return latest
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`${seconds} 秒内没有等到：${what}`)
}

describe.skipIf(!url)('接口约定：对开发环境中的 mock 服务端', () => {
  beforeAll(async () => {
    socket = await connectRoslib(url ?? '', TIMEOUT_MS)
    socket.subscribe(SYSTEM_STATE_TOPIC.name, SYSTEM_STATE_TOPIC.type, (message) => {
      received.push(message)
      latest = systemStateSchema.parse(message)
    })
  })

  afterAll(() => socket?.close())

  it('GetSystemState：回复符合约定，接口版本与 APP 一致', async () => {
    const { name, type } = SERVICES.getSystemState
    const { state } = getSystemStateResponseSchema.parse(
      await socket.call(name, type, {}, TIMEOUT_MS),
    )
    expect(state.interface_version).toBe(INTERFACE_VERSION)
    expect(unknownValues(state)).toEqual([])
  })

  it('system_state：按固定频率发布，每条都符合约定，seq 递增', async () => {
    await new Promise((resolve) => setTimeout(resolve, 1600))
    expect(received.length).toBeGreaterThanOrEqual(3)
    const states = received.map((message) => systemStateSchema.parse(message))
    for (const state of states) expect(unknownValues(state)).toEqual([])
    const seqs = states.map((state) => state.seq)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
  })

  it('准备：复位残留的软件急停，停止残留的任务', async () => {
    let state = await until(() => true, '第一条状态')
    if (state.software_estop) {
      await until(
        (s) => !['SCANNING', 'EXECUTING', 'PAUSED', 'STOPPING'].includes(s.phase),
        '中断完成',
      )
      await accepted(SERVICES.resetEstop)
    }
    state = await until(() => true, '状态')
    if (state.phase === 'EXECUTING' || state.phase === 'PAUSED') {
      await accepted(SERVICES.taskControl, { command: 'STOP', plan_id: '' })
    }
    await until(
      (s) =>
        ['NO_MODEL', 'MODEL_READY', 'PLAN_READY'].includes(s.phase) && s.robot_state === 'READY',
      '可以开始扫描',
    )
  }, 120_000)

  it('TaskControl：未知命令返回 INVALID_ARGUMENT，回复中带完整状态', async () => {
    const response = await call(SERVICES.taskControl, { command: 'JUMP', plan_id: '' })
    expect(response.code).toBe('INVALID_ARGUMENT')
    expect(response.state.interface_version).toBe(INTERFACE_VERSION)
  })

  it('SetLaser：开启后关闭', async () => {
    expect((await accepted(SERVICES.setLaser, { on: true })).laser_state).toBe('ON')
    expect((await accepted(SERVICES.setLaser, { on: false })).laser_state).toBe('OFF')
  })

  it('StartScan：扫描、重建后得到新模型', async () => {
    const before = latest?.model_id
    expect((await accepted(SERVICES.startScan)).phase).toBe('SCANNING')
    const state = await until((s) => s.phase === 'MODEL_READY', '模型就绪')
    expect(state.model_id).not.toBe(before)
    expect(state.model_url).not.toBe('')
  }, 120_000)

  it('StartPlan：模型 ID 不一致时拒绝，空选择规划全部表面', async () => {
    const modelId = latest?.model_id ?? ''
    expect((await call(SERVICES.startPlan, { model_id: 'model_old', surface_ids: [] })).code).toBe(
      'MODEL_MISMATCH',
    )
    expect((await accepted(SERVICES.startPlan, { model_id: modelId, surface_ids: [] })).phase).toBe(
      'PLANNING',
    )
    const state = await until((s) => s.phase === 'PLAN_READY', '规划就绪')
    expect(state.plan_surface_ids.length).toBeGreaterThan(0)
  }, 120_000)

  it('TaskControl：开始、暂停、继续、停止', async () => {
    const planId = latest?.plan_id ?? ''
    expect(
      (await accepted(SERVICES.taskControl, { command: 'START', plan_id: planId })).phase,
    ).toBe('EXECUTING')
    const pause = { command: 'PAUSE', plan_id: '' }
    expect((await accepted(SERVICES.taskControl, pause)).phase).toBe('PAUSED')
    const resume = { command: 'RESUME', plan_id: '' }
    expect((await accepted(SERVICES.taskControl, resume)).phase).toBe('EXECUTING')
    const stop = { command: 'STOP', plan_id: '' }
    expect((await accepted(SERVICES.taskControl, stop)).phase).toBe('STOPPING')
    const state = await until((s) => s.phase === 'PLAN_READY', '停止完成')
    expect(state.last_result).toMatchObject({ operation: 'TASK', result: 'STOPPED' })
  }, 120_000)

  it('机械臂急停 Service 与 ResetEstop', async () => {
    const { name, type } = ESTOP_SERVICE
    const response = triggerResponseSchema.parse(await socket.call(name, type, {}, 1000))
    expect(response.success).toBe(true)
    await until((s) => s.software_estop && s.robot_state === 'ESTOP', '软件急停')
    const state = await accepted(SERVICES.resetEstop)
    expect(state.software_estop).toBe(false)
    expect((await call(SERVICES.resetEstop)).code).toBe('INVALID_STATE')
  }, 30_000)
})
