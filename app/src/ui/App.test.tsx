// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ESTOP_SERVICE, SERVICES, SYSTEM_STATE_TOPIC, type SystemState } from '../ros/contract.ts'
import type { Runtime } from '../runtime.ts'
import type { FakeRosbridge, FakeSocket } from '../testing/fakeRos.ts'
import { stateForPhase } from '../testing/fixtures.ts'
import { answerGet, testRuntime, type TestPlatform } from '../testing/runtime.ts'
import { App } from './App.tsx'
import { RuntimeContext } from './runtimeContext.ts'

// jsdom 没有 WebGL，三维场景在浏览器验证中检查
vi.mock('../scene/SceneCanvas.tsx', () => ({ SceneCanvas: () => null }))

let runtime: Runtime
let bridge: FakeRosbridge
let platform: TestPlatform
let seq = 1

const flush = (ms = 0) => act(() => vi.advanceTimersByTimeAsync(ms))
const button = (key: string) => screen.getByTestId(`btn-${key}`) as HTMLButtonElement
const status = (area: string) => screen.getByTestId(`sb-${area}`).textContent

beforeEach(async () => {
  vi.useFakeTimers()
  seq = 1
  ;({ runtime, bridge, platform } = await testRuntime())
  render(
    <RuntimeContext.Provider value={runtime}>
      <App />
    </RuntimeContext.Provider>,
  )
  await flush()
})

afterEach(() => {
  cleanup()
  runtime.dispose()
  vi.useRealTimers()
})

/** 完成连接，服务端处于 state。 */
async function connect(state: SystemState): Promise<FakeSocket> {
  const socket = bridge.last
  answerGet(socket, { ...state, seq: seq++ })
  await flush()
  return socket
}

/** 服务端发布新状态。 */
async function publish(socket: FakeSocket, state: SystemState) {
  act(() => socket.publish(SYSTEM_STATE_TOPIC.name, { ...state, seq: seq++ }))
  await flush()
}

async function reply(
  socket: FakeSocket,
  name: string,
  code: string,
  state: SystemState,
  detail = '',
) {
  socket.respond(name, { code, detail, state: { ...state, seq: seq++ } })
  await flush()
}

describe('连接前', () => {
  it('Status Bar 显示正在连接，设备和作业状态未知', () => {
    expect(status('service')).toContain('正在连接…')
    for (const area of ['robot', 'phase', 'laser', 'camera']) expect(status(area)).toContain('未知')
    expect(status('alarm')).toContain('无告警')
  })

  it('除急停外的按钮都不可用，不可用的按钮仍然显示', () => {
    for (const key of ['scan', 'select', 'plan', 'animate', 'main', 'stop', 'laser']) {
      expect(button(key).disabled, key).toBe(true)
    }
    expect(button('laser').textContent).toBe('开启激光')
    expect(button('estop').disabled).toBe(false)
  })
})

describe('已连接', () => {
  it('按服务端状态显示 Status Bar 和按钮', async () => {
    await connect(stateForPhase('PLAN_READY'))
    expect(status('service')).toContain('已连接')
    expect(status('robot')).toContain('就绪')
    expect(status('phase')).toContain('规划就绪')
    expect(status('laser')).toContain('关闭')
    expect(status('camera')).toContain('正常')
    expect(button('main').textContent).toBe('开始清洗')
    expect(button('main').className).toContain('is-primary')
    expect(button('stop').disabled).toBe(true)
  })

  it('无模型时三维区中央提示开始扫描', async () => {
    await connect(stateForPhase('NO_MODEL'))
    expect(screen.getByText('暂无模型，请开始扫描')).toBeTruthy()
  })

  it('不需要确认的指令按下即发送；受理后按新状态显示进行中', async () => {
    const socket = await connect(stateForPhase('NO_MODEL'))
    fireEvent.click(button('scan'))
    expect(socket.pendingNames).toEqual([SERVICES.startScan.name])
    expect(button('scan').getAttribute('aria-busy')).toBe('true')
    await reply(socket, SERVICES.startScan.name, 'OK', stateForPhase('SCANNING', { progress: 42 }))
    expect(button('scan').textContent).toBe('正在扫描…')
    expect(screen.getByTestId('progress-card').textContent).toContain('42%')
    expect(status('robot')).toContain('运行中')
  })

  it('需要确认的指令先弹出确认框，确认后发送', async () => {
    const socket = await connect(stateForPhase('PLAN_READY'))
    fireEvent.click(button('main'))
    const dialog = screen.getByRole('dialog', { name: '开始清洗' })
    expect(dialog.textContent).toContain('机械臂将开始运动，请确认作业区域内无人。是否开始清洗？')
    expect(socket.pendingNames).toEqual([])
    fireEvent.click(within(dialog).getByRole('button', { name: '开始清洗' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(socket.calls.at(-1)?.request).toEqual({
      command: 'START',
      plan_id: 'plan_20261015T081000',
    })
  })

  it('取消确认不发送', async () => {
    const socket = await connect(stateForPhase('EXECUTING'))
    fireEvent.click(button('stop'))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(socket.calls.filter((c) => c.name !== SERVICES.getSystemState.name)).toEqual([])
  })

  it('对话框打开期间操作变为不可用时自动关闭（需求 5.4）', async () => {
    const socket = await connect(stateForPhase('PLAN_READY'))
    fireEvent.click(button('main'))
    expect(screen.getByRole('dialog')).toBeTruthy()
    await publish(
      socket,
      stateForPhase('PLAN_READY', { robot_state: 'ESTOP', software_estop: true }),
    )
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('指令被拒绝时显示短时提示，5 秒后消失', async () => {
    const socket = await connect(stateForPhase('NO_MODEL'))
    fireEvent.click(button('laser'))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '开启激光' }))
    await reply(
      socket,
      SERVICES.setLaser.name,
      'INTERLOCK',
      stateForPhase('NO_MODEL'),
      '安全门未关闭',
    )
    const toast = screen.getByRole('status')
    expect(toast.textContent).toContain('安全联锁条件不满足，无法开启激光')
    expect(toast.textContent).toContain('安全门未关闭')
    expect(toast.textContent).toContain('INTERLOCK')
    await flush(5000)
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('激光开启时显示关闭激光，按下立即发送', async () => {
    const socket = await connect(stateForPhase('EXECUTING', { laser_state: 'ON' }))
    expect(button('laser').textContent).toBe('关闭激光')
    expect(button('laser').className).toContain('is-warn')
    fireEvent.click(button('laser'))
    expect(socket.calls.at(-1)?.request).toEqual({ on: false })
  })

  it('结果提示框：id 变化时弹出，点确定关闭', async () => {
    const socket = await connect(stateForPhase('PLAN_READY'))
    await publish(
      socket,
      stateForPhase('PLAN_READY', {
        last_result: {
          id: 'session-a-3',
          operation: 'TASK',
          result: 'INTERRUPTED',
          code: 'ROBOT_ESTOP',
          detail: '设备急停按钮被按下',
          stamp: { sec: 0, nanosec: 0 },
        },
      }),
    )
    const dialog = screen.getByRole('dialog', { name: '清洗已中断' })
    expect(dialog.textContent).toContain('机械臂急停')
    expect(dialog.textContent).toContain('ROBOT_ESTOP')
    fireEvent.click(within(dialog).getByRole('button', { name: '确定' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('急停', () => {
  it('按下即发送，不需要确认', async () => {
    const socket = await connect(stateForPhase('EXECUTING'))
    fireEvent.pointerDown(button('estop'))
    expect(socket.calls.at(-1)?.name).toBe(ESTOP_SERVICE.name)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('未连接时立即显示安全警示，警示打开时仍然可以再按', async () => {
    bridge.last.close()
    await flush()
    fireEvent.pointerDown(button('estop'))
    const alert = screen.getByRole('alertdialog', { name: '急停发送失败' })
    expect(alert.textContent).toContain('请立即使用设备急停按钮')
    expect(alert.textContent).toContain('与服务端的连接已断开，软件急停无法送达机械臂。')
    expect(button('estop').disabled).toBe(false)
  })
})

describe('断线与刷新连接', () => {
  it('超过 3 秒没有状态：显示正在重连，设备状态未知，按钮不可用', async () => {
    await connect(stateForPhase('PLAN_READY'))
    await flush(3000)
    expect(status('service')).toContain('连接断开，正在重连…')
    expect(status('robot')).toContain('未知')
    expect(button('scan').disabled).toBe(true)
  })

  it('点击刷新连接：成功时提示连接成功', async () => {
    await connect(stateForPhase('PLAN_READY'))
    fireEvent.click(screen.getByText('刷新连接'))
    expect(status('service')).toContain('正在连接…')
    await flush()
    await connect(stateForPhase('PLAN_READY'))
    expect(screen.getByRole('status').textContent).toContain('连接成功')
    await flush(2000)
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('回到前台时刷新连接', async () => {
    const first = await connect(stateForPhase('PLAN_READY'))
    act(() => platform.resume())
    expect(first.isOpen).toBe(false)
    await flush()
    expect(bridge.sockets).toHaveLength(2)
  })
})

describe('选面（需求 6.4）', () => {
  it('工具条显示已选数量，可以清空和退出；开始规划发送当前选择并退出选面', async () => {
    const socket = await connect(stateForPhase('PLAN_READY'))
    fireEvent.click(button('select'))
    const toolbar = screen.getByTestId('selection-toolbar')
    expect(toolbar.textContent).toContain('已选 2 个表面')
    act(() => runtime.store.getState().toggleSurface('s1'))
    expect(toolbar.textContent).toContain('已选 1 个表面')

    fireEvent.click(button('plan'))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '开始规划' }))
    expect(socket.calls.at(-1)?.request).toEqual({
      model_id: 'model_20261015T080000',
      surface_ids: ['s2'],
    })
    await reply(socket, SERVICES.startPlan.name, 'OK', stateForPhase('PLANNING'))
    expect(screen.queryByTestId('selection-toolbar')).toBeNull()
  })

  it('清空选择、退出选面', async () => {
    await connect(stateForPhase('PLAN_READY'))
    fireEvent.click(button('select'))
    fireEvent.click(screen.getByRole('button', { name: '清空选择' }))
    expect(screen.getByTestId('selection-toolbar').textContent).toContain('已选 0 个表面')
    fireEvent.click(screen.getByRole('button', { name: '退出选面' }))
    expect(screen.queryByTestId('selection-toolbar')).toBeNull()
    expect(button('scan').disabled).toBe(false)
  })

  it('模型加载期间显示加载卡片，依赖模型的按钮不可用（需求 5.3 规则 8）', async () => {
    await connect(stateForPhase('MODEL_READY'))
    act(() => runtime.store.getState().setModel({ id: 'model_next', status: 'loading' }))
    expect(screen.getByTestId('progress-card').textContent).toContain('正在加载模型…')
    expect(button('select').disabled).toBe(true)
    expect(button('scan').disabled).toBe(false)
    act(() => runtime.store.getState().setModel({ status: 'ready' }))
    expect(screen.queryByTestId('progress-card')).toBeNull()
    expect(button('select').disabled).toBe(false)
  })
})

describe('返回键', () => {
  it('有弹窗时关闭弹窗，处于选面模式时退出模式', async () => {
    await connect(stateForPhase('PLAN_READY'))
    fireEvent.click(button('scan'))
    expect(screen.getByRole('dialog')).toBeTruthy()
    act(() => platform.back())
    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.click(button('select'))
    expect(button('select').className).toContain('is-active')
    act(() => platform.back())
    expect(button('select').className).not.toContain('is-active')
  })
})
