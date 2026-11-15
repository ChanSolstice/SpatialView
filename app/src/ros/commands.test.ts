import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CommandKey } from '../domain/types.ts'
import { createAppStore, type AppState, type AppStore } from '../store/store.ts'
import { FakeSocket } from '../testing/fakeRos.ts'
import { stateForPhase } from '../testing/fixtures.ts'
import {
  createCommands,
  ESTOP_FAILED,
  LASER_OFF_FAILED,
  NO_RESPONSE_TEXT,
  type Commands,
} from './commands.ts'
import { ESTOP_SERVICE, SERVICES, type Phase, type SystemState } from './contract.ts'
import { createStateSync } from './stateSync.ts'

const timing = {
  state_timeout_ms: 3000,
  reconnect_interval_ms: 2000,
  service_timeout_ms: 5000,
  estop_timeout_ms: 1000,
}

let store: AppStore
let socket: FakeSocket
let connection: { current: FakeSocket | null; epoch: number }
let commands: Commands

const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms)
const s = () => store.getState()

/** 已连接、处于给定阶段的 store。 */
function setup(phase: Phase, state: Partial<SystemState> = {}, extra: Partial<AppState> = {}) {
  const server = stateForPhase(phase, { seq: 10, ...state })
  store = createAppStore({
    conn: { status: 'connected', socketOpen: true, sessionId: server.session_id, seq: 10 },
    server,
    lastResultId: '',
    ...extra,
  })
  socket = new FakeSocket('ws://server:9090')
  connection = { current: socket, epoch: 0 }
  commands = createCommands(store, connection, createStateSync(store), timing)
}

const ok = (state: Partial<SystemState> & { phase: Phase }, seq = 11) => ({
  code: 'OK',
  detail: '',
  state: stateForPhase(state.phase, { ...state, seq }),
})

const GENERAL = { workpieceType: 'GENERAL' } as const

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('普通指令', () => {
  it.each([
    ['scan', 'NO_MODEL', SERVICES.startScan, { workpiece_type: 'REVOLVED' }],
    [
      'plan',
      'MODEL_READY',
      SERVICES.startPlan,
      { model_id: 'model_20261015T080000', surface_ids: [] },
    ],
    [
      'start',
      'PLAN_READY',
      SERVICES.taskControl,
      { command: 'START', plan_id: 'plan_20261015T081000' },
    ],
    ['pause', 'EXECUTING', SERVICES.taskControl, { command: 'PAUSE', plan_id: '' }],
    ['resume', 'PAUSED', SERVICES.taskControl, { command: 'RESUME', plan_id: '' }],
    ['stop', 'EXECUTING', SERVICES.taskControl, { command: 'STOP', plan_id: '' }],
    ['laserOn', 'PLAN_READY', SERVICES.setLaser, { on: true }],
  ] as const)('%s：请求与接口文档一致', async (key, phase, service, request) => {
    setup(phase)
    void commands.run(key, { workpieceType: 'REVOLVED' })
    expect(socket.calls).toEqual([
      { name: service.name, type: service.type, request, timeoutMs: timing.service_timeout_ms },
    ])
  })

  it('开始扫描没有工件类型时不发送', async () => {
    setup('NO_MODEL')
    await commands.run('scan')
    expect(socket.calls).toEqual([])
    expect(s().inflight).toBeNull()
  })

  it('上电', async () => {
    setup('PLAN_READY', { robot_state: 'DISABLED' })
    void commands.run('powerOn')
    expect(socket.calls).toEqual([
      {
        name: SERVICES.powerOn.name,
        type: SERVICES.powerOn.type,
        request: {},
        timeoutMs: timing.service_timeout_ms,
      },
    ])
  })

  it('复位急停', async () => {
    setup('PLAN_READY', { robot_state: 'ESTOP', software_estop: true })
    void commands.run('resetEstop')
    expect(socket.calls[0]?.name).toBe(SERVICES.resetEstop.name)
  })

  it('开始规划发送当前选择', async () => {
    setup('PLAN_READY', {}, { selection: new Set(['s3', 's1']) })
    void commands.run('plan')
    expect(socket.calls[0]?.request).toMatchObject({ surface_ids: ['s3', 's1'] })
  })

  it('发出时加在途锁；受理后应用回复中的状态并解锁', async () => {
    setup('NO_MODEL')
    const done = commands.run('scan', GENERAL)
    expect(s().inflight).toBe('scan')
    socket.respond(SERVICES.startScan.name, ok({ phase: 'SCANNING' }))
    await done
    expect(s().inflight).toBeNull()
    expect(s().server?.phase).toBe('SCANNING')
    expect(s().toast).toBeNull()
  })

  it('被拒绝：按状态码提示，附补充说明和状态码', async () => {
    setup('NO_MODEL')
    const done = commands.run('laserOn')
    socket.respond(SERVICES.setLaser.name, {
      code: 'INTERLOCK',
      detail: '安全门未关闭',
      state: stateForPhase('NO_MODEL', { seq: 11 }),
    })
    await done
    expect(s().toast).toMatchObject({
      tone: 'error',
      title: '安全联锁条件不满足，无法开启激光',
      detail: '安全门未关闭',
      code: 'INTERLOCK',
    })
    expect(s().inflight).toBeNull()
  })

  it('超时：提示服务端无响应并解锁', async () => {
    setup('NO_MODEL')
    const done = commands.run('scan', GENERAL)
    await tick(timing.service_timeout_ms)
    await done
    expect(s().toast?.title).toBe(NO_RESPONSE_TEXT)
    expect(s().inflight).toBeNull()
  })

  it('rosbridge 返回调用失败：提示服务端无响应', async () => {
    setup('NO_MODEL')
    const done = commands.run('scan', GENERAL)
    socket.fail(SERVICES.startScan.name, 'failed')
    await done
    expect(s().toast?.title).toBe(NO_RESPONSE_TEXT)
  })

  it('不可用时不发送', async () => {
    setup('EXECUTING')
    await commands.run('scan', GENERAL)
    expect(socket.calls).toEqual([])
    setup(
      'PLAN_READY',
      {},
      { conn: { status: 'reconnecting', socketOpen: true, sessionId: null, seq: 0 } },
    )
    await commands.run('start')
    expect(socket.calls).toEqual([])
  })

  it('有指令在途时其他普通指令不发送', async () => {
    setup('PLAN_READY')
    void commands.run('start')
    await commands.run('laserOn')
    expect(socket.calls).toHaveLength(1)
  })

  it('开始规划被受理后退出选面模式（需求 6.4）', async () => {
    setup('PLAN_READY', {}, { mode: 'select' })
    const done = commands.run('plan')
    socket.respond(SERVICES.startPlan.name, ok({ phase: 'PLANNING' }))
    await done
    expect(s().mode).toBe('browse')
  })

  it('断线后到达的回复直接丢弃：不应用状态、不提示、不再改动在途锁（需求 7.4）', async () => {
    setup('NO_MODEL')
    const done = commands.run('scan', GENERAL)
    // 断线：连接管理解除在途锁，epoch 加 1
    s().releaseCommand()
    connection.epoch += 1
    socket.respond(SERVICES.startScan.name, { code: 'INVALID_STATE', detail: '', state: {} })
    await done
    expect(s().toast).toBeNull()
    expect(s().server?.seq).toBe(10)
  })
})

describe('关闭激光', () => {
  it('不受在途锁限制，也不加锁', async () => {
    setup('EXECUTING', { laser_state: 'ON' })
    void commands.run('pause')
    void commands.laserOff()
    expect(socket.calls.map((c) => c.request)).toEqual([
      { command: 'PAUSE', plan_id: '' },
      { on: false },
    ])
    expect(s().inflight).toBe('pause')
    expect(s().laserOffPending).toBe(1)
  })

  it('受理时不提示', async () => {
    setup('EXECUTING', { laser_state: 'ON' })
    const done = commands.laserOff()
    socket.respond(SERVICES.setLaser.name, ok({ phase: 'EXECUTING', laser_state: 'OFF' }))
    await done
    expect(s().dialogs).toEqual([])
    expect(s().laserOffPending).toBe(0)
    expect(s().server?.laser_state).toBe('OFF')
  })

  it.each([
    [
      '被拒绝',
      (sock: FakeSocket) =>
        sock.respond(SERVICES.setLaser.name, {
          code: 'DEVICE_ERROR',
          detail: '激光器离线',
          state: {},
        }),
      '设备未响应或拒绝执行',
    ],
    [
      '调用失败',
      (sock: FakeSocket) => sock.fail(SERVICES.setLaser.name, 'failed'),
      NO_RESPONSE_TEXT,
    ],
  ])('%s时显示安全警示', async (_, act, reason) => {
    setup('EXECUTING', { laser_state: 'ON' })
    const done = commands.laserOff()
    act(socket)
    await done
    expect(s().dialogs).toMatchObject([{ kind: 'safety', title: LASER_OFF_FAILED.title, reason }])
  })

  it('超时时显示安全警示', async () => {
    setup('EXECUTING', { laser_state: 'ON' })
    const done = commands.laserOff()
    await tick(timing.service_timeout_ms)
    await done
    expect(s().dialogs).toMatchObject([{ kind: 'safety', title: LASER_OFF_FAILED.title }])
  })
})

describe('急停（需求 8.1）', () => {
  const ESTOP = ESTOP_SERVICE.name

  it('只要 WebSocket 打开就发送：不看连接状态、在途锁和接口版本', async () => {
    const extras: Partial<AppState>[] = [
      { conn: { status: 'reconnecting', socketOpen: true, sessionId: null, seq: 0 } },
      { inflight: 'start' as CommandKey },
      { contractError: '状态消息不符合接口约定：phase' },
    ]
    for (const extra of extras) {
      setup('EXECUTING', { interface_version: '2.0' }, extra)
      void commands.estop()
      expect(socket.calls).toEqual([
        {
          name: ESTOP,
          type: 'std_srvs/srv/Trigger',
          request: {},
          timeoutMs: timing.estop_timeout_ms,
        },
      ])
    }
  })

  it('可以重复按，每次都发送；失败提示只显示一个', async () => {
    setup('EXECUTING')
    const presses = [commands.estop(), commands.estop(), commands.estop()]
    expect(socket.calls).toHaveLength(3)
    await tick(timing.estop_timeout_ms)
    await Promise.all(presses)
    expect(s().dialogs).toHaveLength(1)
  })

  it('成功时不提示', async () => {
    setup('EXECUTING')
    const done = commands.estop()
    socket.respond(ESTOP, { success: true, message: '' })
    await done
    expect(s().dialogs).toEqual([])
  })

  it('WebSocket 未打开：立即提示连接已断开', async () => {
    setup('EXECUTING')
    connection.current = null
    await commands.estop()
    expect(s().dialogs).toMatchObject([
      {
        kind: 'safety',
        title: ESTOP_FAILED.title,
        text: ESTOP_FAILED.text,
        reason: ESTOP_FAILED.disconnected,
      },
    ])
    setup('EXECUTING')
    socket.isOpen = false
    await commands.estop()
    expect(s().dialogs[0]).toMatchObject({ reason: ESTOP_FAILED.disconnected })
  })

  it.each([
    [
      'success 为 false',
      (sock: FakeSocket) => sock.respond(ESTOP, { success: false, message: 'not connected' }),
    ],
    ['回复不符合 Trigger', (sock: FakeSocket) => sock.respond(ESTOP, { ok: 1 })],
    ['调用失败', (sock: FakeSocket) => sock.fail(ESTOP, 'failed')],
  ])('%s：提示软件急停未生效', async (_, act) => {
    setup('EXECUTING')
    const done = commands.estop()
    act(socket)
    await done
    expect(s().dialogs).toMatchObject([{ kind: 'safety', reason: ESTOP_FAILED.notApplied }])
  })

  it('超过 estop_timeout_ms 没有回复：提示软件急停未生效', async () => {
    setup('EXECUTING')
    const done = commands.estop()
    await tick(timing.estop_timeout_ms)
    await done
    expect(s().dialogs).toMatchObject([{ reason: ESTOP_FAILED.notApplied }])
  })

  it('回复前连接关闭：提示连接已断开', async () => {
    setup('EXECUTING')
    const done = commands.estop()
    socket.close()
    await done
    expect(s().dialogs).toMatchObject([{ reason: ESTOP_FAILED.disconnected }])
  })
})
