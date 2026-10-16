/** 测试用的 rosbridge 连接：记录调用和订阅，由测试决定回复、失败、超时和断开。不进入打包产物。 */
import { CallError, type CallFailure, type Connect, type RosSocket } from '../ros/transport.ts'

export interface FakeCall {
  name: string
  type: string
  request: object
  timeoutMs: number
}

interface PendingCall extends FakeCall {
  resolve(value: unknown): void
  reject(error: CallError): void
}

export class FakeSocket implements RosSocket {
  isOpen = true
  readonly calls: FakeCall[] = []
  private readonly pending: PendingCall[] = []
  private readonly subscribers = new Map<string, (message: unknown) => void>()
  private readonly closeListeners: (() => void)[] = []
  readonly url: string

  constructor(url: string) {
    this.url = url
  }

  call(name: string, type: string, request: object, timeoutMs: number): Promise<unknown> {
    if (!this.isOpen) return Promise.reject(new CallError('closed', '连接未打开'))
    this.calls.push({ name, type, request, timeoutMs })
    return new Promise((resolve, reject) => {
      const entry: PendingCall = { name, type, request, timeoutMs, resolve, reject }
      this.pending.push(entry)
      // 与真实实现一致：超时由连接自己判定
      setTimeout(
        () => this.settle(entry, () => reject(new CallError('timeout', '超时'))),
        timeoutMs,
      )
    })
  }

  subscribe(name: string, _type: string, onMessage: (message: unknown) => void): () => void {
    this.subscribers.set(name, onMessage)
    return () => this.subscribers.delete(name)
  }

  onClose(listener: () => void): void {
    if (!this.isOpen) listener()
    else this.closeListeners.push(listener)
  }

  close(): void {
    if (!this.isOpen) return
    this.isOpen = false
    for (const entry of [...this.pending]) {
      this.settle(entry, () => entry.reject(new CallError('closed', '连接已关闭')))
    }
    for (const listener of this.closeListeners.splice(0)) listener()
  }

  // 以下供测试使用

  /** 尚未回复的调用的 Service 名称。 */
  get pendingNames(): string[] {
    return this.pending.map((entry) => entry.name)
  }

  isSubscribed(topic: string): boolean {
    return this.subscribers.has(topic)
  }

  /** 回复最早一个尚未回复的同名调用。 */
  respond(name: string, value: unknown): void {
    const entry = this.take(name)
    this.settle(entry, () => entry.resolve(value))
  }

  /** 让最早一个尚未回复的同名调用失败。 */
  fail(name: string, failure: CallFailure = 'failed'): void {
    const entry = this.take(name)
    this.settle(entry, () => entry.reject(new CallError(failure, '调用失败')))
  }

  publish(topic: string, message: unknown): void {
    this.subscribers.get(topic)?.(message)
  }

  private take(name: string): PendingCall {
    const entry = this.pending.find((e) => e.name === name)
    if (!entry) throw new Error(`没有尚未回复的 ${name} 调用`)
    return entry
  }

  private settle(entry: PendingCall, action: () => void): void {
    const index = this.pending.indexOf(entry)
    if (index < 0) return
    this.pending.splice(index, 1)
    action()
  }
}

/** 建立连接的替身：refuse 为 true 时连接失败；hang 为 true 时一直不打开，直到超时。 */
export class FakeRosbridge {
  readonly sockets: FakeSocket[] = []
  refuse = false
  hang = false

  readonly connect: Connect = (url, timeoutMs) =>
    new Promise((resolve, reject) => {
      if (this.hang) {
        setTimeout(() => reject(new Error('连接超时')), timeoutMs)
      } else if (this.refuse) {
        queueMicrotask(() => reject(new Error('连接被拒绝')))
      } else {
        const socket = new FakeSocket(url)
        this.sockets.push(socket)
        queueMicrotask(() => resolve(socket))
      }
    })

  get last(): FakeSocket {
    const socket = this.sockets.at(-1)
    if (!socket) throw new Error('还没有建立过连接')
    return socket
  }
}
