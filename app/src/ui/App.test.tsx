// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ESTOP_SERVICE,
  INTERFACE_VERSION,
  SERVICES,
  SYSTEM_STATE_TOPIC,
  type SystemState,
} from '../ros/contract.ts'
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

describe('轨迹动画（需求 6.6）', () => {
  async function enter() {
    const socket = await connect(stateForPhase('PLAN_READY'))
    // 规划和机械臂加载完成后才可用
    await flush()
    expect(button('animate').disabled).toBe(false)
    fireEvent.click(button('animate'))
    return socket
  }
  const bar = () => screen.getByTestId('playbar')
  const animation = () => runtime.store.getState().animation

  it('进入后显示标签和播放条，从头开始播放；不向服务端发送任何指令', async () => {
    const socket = await connect(stateForPhase('PLAN_READY'))
    await flush()
    const calls = socket.calls.length
    fireEvent.click(button('animate'))
    expect(screen.getByTestId('animation-tag').textContent).toBe('轨迹动画 · 非实际位置')
    expect(bar().textContent).toContain('00:00 / 00:10')
    expect(within(bar()).getByRole('button', { name: '暂停' })).toBeTruthy()
    expect(animation()).toMatchObject({ time: 0, playing: true, speed: 1 })
    expect(button('animate').className).toContain('is-active')
    expect(button('animate').disabled).toBe(true)
    expect(socket.calls.length).toBe(calls)
  })

  it('暂停、继续；播放结束后停在最后一帧，再按播放从头开始；重新播放', async () => {
    await enter()
    fireEvent.click(within(bar()).getByRole('button', { name: '暂停' }))
    expect(animation().playing).toBe(false)
    act(() => runtime.store.getState().setAnimation({ time: 10, playing: false }))
    expect(bar().textContent).toContain('00:10 / 00:10')
    fireEvent.click(within(bar()).getByRole('button', { name: '播放' }))
    expect(animation()).toMatchObject({ time: 0, playing: true })
    act(() => runtime.store.getState().setAnimation({ time: 4 }))
    fireEvent.click(within(bar()).getByRole('button', { name: '重新播放' }))
    expect(animation()).toMatchObject({ time: 0, playing: true })
  })

  it('倍速按配置的档位切换，再次进入时沿用', async () => {
    await enter()
    const speeds = within(bar()).getByRole('group', { name: '倍速' })
    expect(
      within(speeds)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['1×', '5×', '20×'])
    fireEvent.click(within(speeds).getByRole('button', { name: '20×' }))
    expect(animation().speed).toBe(20)
    expect(within(speeds).getByRole('button', { name: '20×' }).getAttribute('aria-pressed')).toBe(
      'true',
    )
    fireEvent.click(within(bar()).getByRole('button', { name: '退出' }))
    fireEvent.click(button('animate'))
    expect(animation()).toMatchObject({ time: 0, playing: true, speed: 20 })
  })

  it('拖动进度条：拖动期间暂停，松开后恢复播放', async () => {
    await enter()
    const track = within(bar()).getByRole('slider', { name: '播放进度' })
    track.setPointerCapture = () => {}
    track.releasePointerCapture = () => {}
    track.getBoundingClientRect = () => ({ left: 100, width: 200 }) as DOMRect
    fireEvent.pointerDown(track, { pointerId: 1, clientX: 150 })
    expect(animation()).toMatchObject({ time: 2.5, playing: false })
    fireEvent.pointerMove(track, { pointerId: 1, clientX: 260 })
    expect(animation().time).toBe(8)
    fireEvent.pointerUp(track, { pointerId: 1, clientX: 260 })
    expect(animation().playing).toBe(true)
    expect(track.getAttribute('aria-valuenow')).toBe('8')
  })

  it('退出：点击退出、返回键；阶段离开规划就绪时自动退出', async () => {
    const socket = await enter()
    fireEvent.click(within(bar()).getByRole('button', { name: '退出' }))
    expect(screen.queryByTestId('playbar')).toBeNull()
    expect(screen.queryByTestId('animation-tag')).toBeNull()

    fireEvent.click(button('animate'))
    act(() => platform.back())
    expect(runtime.store.getState().mode).toBe('browse')

    fireEvent.click(button('animate'))
    await publish(socket, stateForPhase('EXECUTING'))
    expect(runtime.store.getState().mode).toBe('browse')
    expect(screen.queryByTestId('playbar')).toBeNull()
  })
})

describe('机械臂提示与复位急停（需求 5.6；需求 12.4 场景 6）', () => {
  const notice = () => screen.queryByTestId('robot-notice')
  const resetButton = () =>
    within(notice() as HTMLElement).queryByRole('button', { name: '复位急停' })

  it('依次为未启动、设备急停、软件急停：只有软件急停有复位，确认后发送复位，提示消失', async () => {
    const socket = await connect(stateForPhase('PLAN_READY', { robot_state: 'DISABLED' }))
    expect(notice()?.textContent).toContain('机械臂未启动')
    expect(notice()?.textContent).toContain('请在示教器上启动机械臂（上电并松开刹车）。')
    expect(resetButton()).toBeNull()

    await publish(socket, stateForPhase('PLAN_READY', { robot_state: 'ESTOP' }))
    expect(notice()?.textContent).toContain('设备急停已触发')
    expect(resetButton()).toBeNull()

    await publish(
      socket,
      stateForPhase('PLAN_READY', { robot_state: 'ESTOP', software_estop: true }),
    )
    expect(notice()?.textContent).toContain('软件急停已触发')
    expect(resetButton()?.hasAttribute('disabled')).toBe(false)

    fireEvent.click(resetButton() as HTMLElement)
    const dialog = screen.getByRole('dialog')
    expect(dialog.textContent).toContain('复位后机械臂可以重新接受运动指令，但不会自动运动')
    fireEvent.click(within(dialog).getByRole('button', { name: '复位急停' }))
    expect(socket.calls.at(-1)?.name).toBe(SERVICES.resetEstop.name)
    expect(resetButton()?.hasAttribute('disabled')).toBe(true)
    await reply(socket, SERVICES.resetEstop.name, 'OK', stateForPhase('PLAN_READY'))
    expect(notice()).toBeNull()
  })

  it('复位后设备急停仍未解除时，改为显示设备急停的提示', async () => {
    const socket = await connect(
      stateForPhase('MODEL_READY', { robot_state: 'ESTOP', software_estop: true }),
    )
    fireEvent.click(resetButton() as HTMLElement)
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '复位急停' }))
    await reply(
      socket,
      SERVICES.resetEstop.name,
      'OK',
      stateForPhase('MODEL_READY', { robot_state: 'ESTOP' }),
    )
    expect(notice()?.textContent).toContain('设备急停已触发')
  })

  it('急停引起的中断尚未完成时不能复位；选面模式中可以复位', async () => {
    const socket = await connect(
      stateForPhase('STOPPING', { robot_state: 'ESTOP', software_estop: true }),
    )
    expect(resetButton()?.hasAttribute('disabled')).toBe(true)
    await publish(
      socket,
      stateForPhase('PLAN_READY', { robot_state: 'ESTOP', software_estop: true }),
    )
    fireEvent.click(button('select'))
    expect(runtime.store.getState().mode).toBe('select')
    expect(resetButton()?.hasAttribute('disabled')).toBe(false)
  })

  it('确认框打开期间复位变为不可用时自动关闭，不发送', async () => {
    const socket = await connect(
      stateForPhase('PLAN_READY', { robot_state: 'ESTOP', software_estop: true }),
    )
    fireEvent.click(resetButton() as HTMLElement)
    expect(screen.getByRole('dialog')).toBeTruthy()
    const calls = socket.calls.length
    await publish(socket, stateForPhase('PLAN_READY'))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(socket.calls.length).toBe(calls)
  })

  it('断线后机械臂状态未知，不显示提示', async () => {
    await connect(stateForPhase('PLAN_READY', { robot_state: 'DISABLED' }))
    expect(notice()).not.toBeNull()
    act(() => runtime.store.getState().setConn({ status: 'reconnecting' }))
    expect(notice()).toBeNull()
  })
})

describe('告警面板（需求 9.2；前端UI设计 4.6）', () => {
  const panel = () => screen.queryByTestId('alarm-panel')
  const alarm = (code: string, level: string, sec: number, detail = '') => ({
    code,
    level,
    detail,
    stamp: { sec, nanosec: 0 },
  })
  const withAlarms = stateForPhase('PLAN_READY', {
    robot_state: 'FAULT',
    alarms: [
      alarm('ROBOT_FAULT', 'ERROR', 1_792_000_100, '第 3 轴驱动器过温'),
      alarm('PLAN_FAILED', 'WARNING', 1_792_000_200),
      alarm('VENDOR_X', 'ERROR', 1_792_000_000),
    ],
  })

  it('点击告警按钮展开，按时间倒序列出：名称、级别标签、补充说明、告警码', async () => {
    await connect(withAlarms)
    expect(status('alarm')).toContain('3 个告警')
    fireEvent.click(screen.getByTestId('sb-alarm'))
    expect(screen.getByTestId('sb-alarm').getAttribute('aria-expanded')).toBe('true')
    const items = [...(panel() as HTMLElement).querySelectorAll('.alarm')].map((e) => e.textContent)
    expect(panel()?.textContent).toContain('告警（3）')
    expect(items[0]).toContain('规划失败警告')
    expect(items[1]).toContain('机械臂故障错误')
    expect(items[1]).toContain('第 3 轴驱动器过温')
    expect(items[1]).toContain('ROBOT_FAULT')
    // 未知告警码显示为"设备告警"，照常显示告警码
    expect(items[2]).toContain('设备告警')
    expect(items[2]).toContain('VENDOR_X')
    fireEvent.click(within(panel() as HTMLElement).getByRole('button', { name: '关闭' }))
    expect(panel()).toBeNull()
  })

  it('点击面板外收起；面板打开时按急停，急停照常发送', async () => {
    const socket = await connect(withAlarms)
    fireEvent.click(screen.getByTestId('sb-alarm'))
    fireEvent.pointerDown(screen.getByTestId('scene'))
    expect(panel()).toBeNull()

    fireEvent.click(screen.getByTestId('sb-alarm'))
    fireEvent.pointerDown(button('estop'))
    fireEvent.click(button('estop'))
    expect(panel()).toBeNull()
    expect(socket.calls.at(-1)?.name).toBe(ESTOP_SERVICE.name)
  })

  it('断线：保留断线前的服务端告警并标注，另加本地告警"网络连接断开"', async () => {
    await connect(withAlarms)
    act(() => runtime.store.getState().setConn({ status: 'reconnecting', socketOpen: false }))
    expect(status('alarm')).toContain('4 个告警')
    fireEvent.click(screen.getByTestId('sb-alarm'))
    expect(panel()?.textContent).toContain('以下为断线前的告警')
    expect(panel()?.textContent).toContain('网络连接断开')
    expect(panel()?.textContent).toContain('APP_NETWORK_DOWN')
  })

  it('没有告警时显示"当前没有告警"；返回键收起面板', async () => {
    await connect(stateForPhase('PLAN_READY'))
    fireEvent.click(screen.getByTestId('sb-alarm'))
    expect(panel()?.textContent).toContain('当前没有告警')
    act(() => platform.back())
    expect(panel()).toBeNull()
  })
})

describe('断线遮罩（需求 7.4；前端UI设计 6.11）', () => {
  const mask = () => screen.queryByTestId('disconnect-mask')

  it('启动时还没有连接过，不加遮罩', () => {
    expect(mask()).toBeNull()
  })

  it('断线后三维区加遮罩，重连中；刷新连接时为正在连接；连接后遮罩消失', async () => {
    await connect(stateForPhase('PLAN_READY'))
    expect(mask()).toBeNull()
    act(() => runtime.store.getState().setConn({ status: 'reconnecting', socketOpen: false }))
    expect(mask()?.textContent).toContain('连接断开，画面内容可能已过期')
    expect(mask()?.textContent).toContain('正在重连…')
    act(() => runtime.store.getState().setConn({ status: 'connecting' }))
    expect(mask()?.textContent).toContain('正在连接…')
    act(() => runtime.store.getState().setConn({ status: 'connected', socketOpen: true }))
    expect(mask()).toBeNull()
  })
})

describe('接口版本不匹配（需求 7.7；需求 12.4 场景 3）', () => {
  it('本地告警；除急停和关闭激光外的指令按钮不可用；版本恢复一致后告警消失', async () => {
    const socket = await connect(
      stateForPhase('PLAN_READY', { interface_version: '2.0', laser_state: 'ON' }),
    )
    expect(status('alarm')).toContain('1 个告警')
    for (const key of ['scan', 'select', 'plan', 'animate', 'main', 'stop']) {
      expect(button(key).disabled, key).toBe(true)
    }
    expect(button('laser').textContent).toBe('关闭激光')
    expect(button('laser').disabled).toBe(false)
    expect(button('estop').disabled).toBe(false)
    fireEvent.click(screen.getByTestId('sb-alarm'))
    const panel = screen.getByTestId('alarm-panel')
    expect(panel.textContent).toContain('接口版本不匹配')
    expect(panel.textContent).toContain(`服务端接口版本 2.0，APP 期望 ${INTERFACE_VERSION}`)

    await publish(socket, stateForPhase('PLAN_READY'))
    expect(status('alarm')).toContain('无告警')
    expect(button('scan').disabled).toBe(false)
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
