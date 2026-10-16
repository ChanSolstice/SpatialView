/**
 * 连接管理（需求 7.1–7.3；架构设计 5.3）：建立连接、获取状态并订阅、两层断线判定、自动重连、刷新连接。
 *
 * - 每次连接尝试都新建一个连接；旧连接的回调按"是否仍是当前连接"丢弃，迟到的事件不干扰新连接。
 * - WebSocket 关闭或出错：关闭连接，按间隔新建连接重试。
 * - 超过 state_timeout_ms 没有收到状态，但 WebSocket 仍打开：保留连接和订阅，按间隔重新调用 GetSystemState，
 *   使急停在服务端程序异常时仍能经这条连接送达机械臂驱动。GetSystemState 在 service_timeout_ms 内没有任何
 *   回应时连接实际已失效，关闭后新建；rosbridge 返回调用失败也算有回应。
 */
import type { Config } from '../config/schema.ts'
import type { ConnStatus } from '../domain/types.ts'
import { SERVICES, SYSTEM_STATE_TOPIC } from './contract.ts'
import { CallError, type Connect, type RosSocket } from './transport.ts'

export interface ConnectionEvents {
  onStatus(status: ConnStatus, socketOpen: boolean): void
  /** GetSystemState 的回复，或已连接期间收到的 Topic 消息。 */
  onState(raw: unknown, source: 'get' | 'topic'): void
  /** 离开 connected 时调用：在途指令的锁定立即解除（需求 7.4）。 */
  onDisconnect(): void
  /** 点击刷新连接后第一次尝试的结果（需求 7.3）。 */
  onRefreshResult(ok: boolean): void
}

export interface ConnectionOptions {
  url: string
  timing: Config['timing']
  connect: Connect
}

type Timer = ReturnType<typeof setTimeout>

export class ConnectionManager {
  private readonly options: ConnectionOptions
  private readonly events: ConnectionEvents
  private running = false
  /** 每次新的连接尝试加 1，丢弃已被取代的尝试的结果。 */
  private attempts = 0
  private socket: RosSocket | null = null
  private unsubscribe: (() => void) | null = null
  private retryTimer: Timer | undefined
  private watchdog: Timer | undefined
  private status: ConnStatus = 'connecting'
  private reported: [ConnStatus, boolean] | null = null
  private refreshPending = false
  private disconnects = 0

  constructor(options: ConnectionOptions, events: ConnectionEvents) {
    this.options = options
    this.events = events
  }

  /** 当前的连接（可能尚未取得状态）。急停只看它是否打开。 */
  get current(): RosSocket | null {
    return this.socket
  }

  /** 每次离开 connected 加 1。指令通道据此丢弃断线前发出的指令的结果（需求 7.4）。 */
  get epoch(): number {
    return this.disconnects
  }

  start(): void {
    if (this.running) return
    this.running = true
    void this.attempt('connecting')
  }

  /** 刷新连接：主动断开旧连接，立即重新连接（需求 7.3）。byUser 为 true 时报告结果。 */
  refresh(byUser: boolean): void {
    if (!this.running) return
    this.drop()
    this.refreshPending = byUser
    void this.attempt('connecting')
  }

  stop(): void {
    this.running = false
    this.attempts += 1
    this.drop()
  }

  private async attempt(status: 'connecting' | 'reconnecting'): Promise<void> {
    const attempt = ++this.attempts
    this.setStatus(status)
    const { url, timing, connect } = this.options
    let socket: RosSocket
    try {
      socket = await connect(url, timing.service_timeout_ms)
    } catch {
      if (attempt === this.attempts) this.reconnect()
      return
    }
    if (attempt !== this.attempts) {
      socket.close()
      return
    }
    this.socket = socket
    socket.onClose(() => {
      if (this.socket === socket) this.reconnect()
    })
    this.setStatus(this.status)
    await this.sync(socket)
  }

  /** 7.1 的第 2–5 步：获取完整状态，订阅，进入 connected。 */
  private async sync(socket: RosSocket): Promise<void> {
    const { name, type } = SERVICES.getSystemState
    try {
      const response = await socket.call(name, type, {}, this.options.timing.service_timeout_ms)
      if (this.socket !== socket) return
      this.events.onState(response, 'get')
      this.unsubscribe ??= socket.subscribe(
        SYSTEM_STATE_TOPIC.name,
        SYSTEM_STATE_TOPIC.type,
        (message) => this.onTopic(socket, message),
      )
      this.setStatus('connected')
      this.kickWatchdog(socket)
      this.reportRefresh(true)
    } catch (error) {
      if (this.socket !== socket) return
      if (error instanceof CallError && error.failure === 'failed') {
        // rosbridge 有回应，连接本身正常：保留连接，按间隔重试
        this.setStatus('reconnecting')
        this.reportRefresh(false)
        this.schedule(() => void this.sync(socket))
      } else {
        this.reconnect()
      }
    }
  }

  private onTopic(socket: RosSocket, message: unknown): void {
    // 断线后到重新取得完整状态之前，不应用 Topic 消息
    if (this.socket !== socket || this.status !== 'connected') return
    this.kickWatchdog(socket)
    this.events.onState(message, 'topic')
  }

  /** 状态超时看门狗：每收到一条状态就重置（需求 7.2）。 */
  private kickWatchdog(socket: RosSocket): void {
    clearTimeout(this.watchdog)
    this.watchdog = setTimeout(() => {
      if (this.socket !== socket) return
      if (!socket.isOpen) return this.reconnect()
      this.setStatus('reconnecting')
      this.schedule(() => void this.sync(socket))
    }, this.options.timing.state_timeout_ms)
  }

  /** 关闭当前连接，按间隔新建连接重试。 */
  private reconnect(): void {
    this.drop()
    this.setStatus('reconnecting')
    this.reportRefresh(false)
    this.schedule(() => void this.attempt('reconnecting'))
  }

  /** 关闭实例时统一清理：取消订阅、关闭连接（未完成的调用随之失败）、停止计时器。 */
  private drop(): void {
    clearTimeout(this.watchdog)
    clearTimeout(this.retryTimer)
    const socket = this.socket
    this.socket = null
    this.unsubscribe?.()
    this.unsubscribe = null
    socket?.close()
  }

  private schedule(task: () => void): void {
    clearTimeout(this.retryTimer)
    this.retryTimer = setTimeout(() => {
      if (this.running) task()
    }, this.options.timing.reconnect_interval_ms)
  }

  private setStatus(status: ConnStatus): void {
    if (this.status === 'connected' && status !== 'connected') {
      this.disconnects += 1
      this.events.onDisconnect()
    }
    this.status = status
    const socketOpen = this.socket?.isOpen ?? false
    if (this.reported?.[0] === status && this.reported[1] === socketOpen) return
    this.reported = [status, socketOpen]
    this.events.onStatus(status, socketOpen)
  }

  private reportRefresh(ok: boolean): void {
    if (!this.refreshPending) return
    this.refreshPending = false
    this.events.onRefreshResult(ok)
  }
}
