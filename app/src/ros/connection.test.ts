import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnStatus } from '../domain/types.ts'
import { FakeRosbridge, type FakeSocket } from '../testing/fakeRos.ts'
import { makeState } from '../testing/fixtures.ts'
import { ConnectionManager } from './connection.ts'
import { SERVICES, SYSTEM_STATE_TOPIC } from './contract.ts'

const GET = SERVICES.getSystemState.name
const TOPIC = SYSTEM_STATE_TOPIC.name
const timing = {
  state_timeout_ms: 3000,
  reconnect_interval_ms: 2000,
  service_timeout_ms: 5000,
  estop_timeout_ms: 1000,
}

let bridge: FakeRosbridge
let manager: ConnectionManager
let statuses: [ConnStatus, boolean][]
let states: [unknown, string][]
let disconnects: number
let refreshResults: boolean[]

const status = () => statuses.at(-1)?.[0]
const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms)

beforeEach(() => {
  vi.useFakeTimers()
  bridge = new FakeRosbridge()
  statuses = []
  states = []
  disconnects = 0
  refreshResults = []
  manager = new ConnectionManager(
    { url: 'ws://server:9090', timing, connect: bridge.connect },
    {
      onStatus: (s, open) => statuses.push([s, open]),
      onState: (raw, source) => states.push([raw, source]),
      onDisconnect: () => (disconnects += 1),
      onRefreshResult: (ok) => refreshResults.push(ok),
    },
  )
})

afterEach(() => {
  manager.stop()
  vi.useRealTimers()
})

/** 建立连接并完成 GetSystemState，进入 connected。 */
async function connected(): Promise<FakeSocket> {
  manager.start()
  await tick()
  const socket = bridge.last
  socket.respond(GET, { state: makeState() })
  await tick()
  expect(status()).toBe('connected')
  return socket
}

describe('连接流程（需求 7.1）', () => {
  it('建立连接、获取完整状态、订阅后进入 connected', async () => {
    manager.start()
    expect(statuses).toEqual([['connecting', false]])
    await tick()
    const socket = bridge.last
    expect(socket.url).toBe('ws://server:9090')
    expect(socket.pendingNames).toEqual([GET])
    expect(socket.isSubscribed(TOPIC)).toBe(false)
    expect(statuses.at(-1)).toEqual(['connecting', true])

    socket.respond(GET, { state: 'S' })
    await tick()
    expect(states).toEqual([[{ state: 'S' }, 'get']])
    expect(socket.isSubscribed(TOPIC)).toBe(true)
    expect(statuses.at(-1)).toEqual(['connected', true])
    expect(manager.current).toBe(socket)
  })

  it('已连接时 Topic 消息交给 stateSync', async () => {
    const socket = await connected()
    socket.publish(TOPIC, { seq: 2 })
    expect(states.at(-1)).toEqual([{ seq: 2 }, 'topic'])
  })

  it('连接失败时显示正在重连，并按间隔不限次数地重试', async () => {
    bridge.refuse = true
    manager.start()
    await tick()
    expect(status()).toBe('reconnecting')
    for (let i = 0; i < 5; i++) await tick(timing.reconnect_interval_ms)
    expect(bridge.sockets).toHaveLength(0)
    bridge.refuse = false
    await tick(timing.reconnect_interval_ms)
    bridge.last.respond(GET, { state: 'S' })
    await tick()
    expect(status()).toBe('connected')
  })

  it('连接一直打不开时，超过 service_timeout_ms 后按失败处理', async () => {
    bridge.hang = true
    manager.start()
    await tick(timing.service_timeout_ms - 1)
    expect(status()).toBe('connecting')
    await tick(1)
    expect(status()).toBe('reconnecting')
  })
})

describe('断线判定与自动重连（需求 7.2）', () => {
  it('WebSocket 关闭：清理连接，按间隔新建连接', async () => {
    const socket = await connected()
    socket.close()
    expect(statuses.at(-1)).toEqual(['reconnecting', false])
    expect(disconnects).toBe(1)
    expect(manager.current).toBeNull()
    await tick(timing.reconnect_interval_ms - 1)
    expect(bridge.sockets).toHaveLength(1)
    await tick(1)
    expect(bridge.sockets).toHaveLength(2)
    bridge.last.respond(GET, { state: 'S' })
    await tick()
    expect(status()).toBe('connected')
  })

  it('超过 state_timeout_ms 没有状态、WebSocket 仍打开：保留连接和订阅，重新调用 GetSystemState', async () => {
    const socket = await connected()
    await tick(2000)
    socket.publish(TOPIC, { seq: 2 }) // 收到状态，重置看门狗
    await tick(timing.state_timeout_ms - 1)
    expect(status()).toBe('connected')
    await tick(1)
    expect(statuses.at(-1)).toEqual(['reconnecting', true])
    expect(disconnects).toBe(1)
    expect(manager.current).toBe(socket)
    expect(socket.isSubscribed(TOPIC)).toBe(true)

    await tick(timing.reconnect_interval_ms)
    expect(socket.pendingNames).toEqual([GET])
    socket.respond(GET, { state: 'S2' })
    await tick()
    expect(status()).toBe('connected')
    expect(bridge.sockets).toHaveLength(1)
  })

  it('断线后、重新取得完整状态之前不应用 Topic 消息', async () => {
    const socket = await connected()
    await tick(timing.state_timeout_ms)
    const count = states.length
    socket.publish(TOPIC, { seq: 9 })
    expect(states).toHaveLength(count)
  })

  it('rosbridge 返回调用失败也算有回应：保留连接，按间隔重试', async () => {
    const socket = await connected()
    await tick(timing.state_timeout_ms + timing.reconnect_interval_ms)
    for (let i = 0; i < 3; i++) {
      socket.fail(GET, 'failed')
      await tick()
      expect(statuses.at(-1)).toEqual(['reconnecting', true])
      await tick(timing.reconnect_interval_ms)
    }
    expect(bridge.sockets).toHaveLength(1)
    socket.respond(GET, { state: 'S' })
    await tick()
    expect(status()).toBe('connected')
  })

  it('GetSystemState 没有任何回应：关闭连接，改为新建', async () => {
    const socket = await connected()
    await tick(timing.state_timeout_ms + timing.reconnect_interval_ms)
    expect(socket.pendingNames).toEqual([GET])
    await tick(timing.service_timeout_ms)
    expect(socket.isOpen).toBe(false)
    expect(manager.current).toBeNull()
    await tick(timing.reconnect_interval_ms)
    expect(bridge.sockets).toHaveLength(2)
  })

  it('首次连接时服务端程序未运行：保留连接，状态为正在重连', async () => {
    manager.start()
    await tick()
    const socket = bridge.last
    socket.fail(GET, 'failed')
    await tick()
    expect(statuses.at(-1)).toEqual(['reconnecting', true])
    expect(manager.current).toBe(socket)
    expect(disconnects).toBe(0)
  })

  it('每次离开 connected，epoch 加 1', async () => {
    const socket = await connected()
    expect(manager.epoch).toBe(0)
    socket.close()
    expect(manager.epoch).toBe(1)
    await tick(timing.reconnect_interval_ms)
    bridge.last.respond(GET, { state: 'S' })
    await tick()
    await tick(timing.state_timeout_ms)
    expect(manager.epoch).toBe(2)
  })
})

describe('刷新连接（需求 7.3）', () => {
  it('主动断开旧连接，立即重新连接，并报告成功', async () => {
    const old = await connected()
    manager.refresh(true)
    expect(old.isOpen).toBe(false)
    expect(status()).toBe('connecting')
    expect(disconnects).toBe(1)
    await tick()
    expect(bridge.sockets).toHaveLength(2)
    bridge.last.respond(GET, { state: 'S' })
    await tick()
    expect(status()).toBe('connected')
    expect(refreshResults).toEqual([true])
  })

  it('失败时报告一次，之后继续自动重连', async () => {
    await connected()
    bridge.refuse = true
    manager.refresh(true)
    await tick()
    expect(refreshResults).toEqual([false])
    expect(status()).toBe('reconnecting')
    bridge.refuse = false
    await tick(timing.reconnect_interval_ms)
    bridge.last.respond(GET, { state: 'S' })
    await tick()
    expect(status()).toBe('connected')
    expect(refreshResults).toEqual([false])
  })

  it('回到前台的刷新不报告结果', async () => {
    await connected()
    manager.refresh(false)
    await tick()
    bridge.last.respond(GET, { state: 'S' })
    await tick()
    expect(refreshResults).toEqual([])
  })

  it('丢弃旧连接迟到的回复和消息', async () => {
    manager.start()
    await tick()
    const old = bridge.last
    manager.refresh(true)
    await tick()
    const current = bridge.last
    expect(current).not.toBe(old)
    // 旧连接已关闭，它的回调不再起作用
    old.publish(TOPIC, { seq: 99 })
    current.respond(GET, { state: 'new' })
    await tick()
    expect(states).toEqual([[{ state: 'new' }, 'get']])
  })
})

describe('stop', () => {
  it('关闭连接，不再重试', async () => {
    const socket = await connected()
    manager.stop()
    expect(socket.isOpen).toBe(false)
    await tick(timing.reconnect_interval_ms * 5)
    expect(bridge.sockets).toHaveLength(1)
  })
})
