/**
 * 一条 rosbridge 连接的抽象，以及基于 roslib 的实现。连接管理和指令通道只依赖这里的接口，
 * 测试中用假的实现替换（架构设计 5.3、5.5）。
 */
import { Ros, Service, Topic } from 'roslib'

/**
 * Service 调用失败的原因。failed：rosbridge 返回调用失败（例如服务端程序未运行），说明连接本身正常；
 * timeout：超时没有任何回应；closed：连接未打开或在回复前关闭。
 */
export type CallFailure = 'failed' | 'timeout' | 'closed'

export class CallError extends Error {
  readonly failure: CallFailure

  constructor(failure: CallFailure, message: string) {
    super(message)
    this.name = 'CallError'
    this.failure = failure
  }
}

export interface RosSocket {
  /** WebSocket 是否打开。 */
  readonly isOpen: boolean
  /** 调用 Service；失败时以 CallError 拒绝。 */
  call(name: string, type: string, request: object, timeoutMs: number): Promise<unknown>
  /** 订阅 Topic，返回取消订阅的函数。 */
  subscribe(name: string, type: string, onMessage: (message: unknown) => void): () => void
  /** 连接关闭时调用，只调用一次。 */
  onClose(listener: () => void): void
  /** 关闭连接；未完成的调用立即以 closed 失败。 */
  close(): void
}

/** 建立连接：WebSocket 打开后返回；超时或失败时拒绝。 */
export type Connect = (url: string, timeoutMs: number) => Promise<RosSocket>

class RoslibSocket implements RosSocket {
  private readonly ros: Ros
  private readonly pending = new Set<(error: CallError) => void>()
  private readonly closeListeners: (() => void)[] = []
  private closed = false

  constructor(ros: Ros) {
    this.ros = ros
    ros.on('close', () => this.handleClose())
  }

  get isOpen(): boolean {
    return !this.closed && this.ros.isConnected
  }

  call(name: string, type: string, request: object, timeoutMs: number): Promise<unknown> {
    if (!this.isOpen) return Promise.reject(new CallError('closed', '连接未打开'))
    return new Promise((resolve, reject) => {
      let done = false
      const finish = (settle: () => void) => {
        if (done) return
        done = true
        clearTimeout(timer)
        this.pending.delete(abort)
        settle()
      }
      const abort = (error: CallError) => finish(() => reject(error))
      const timer = setTimeout(
        () => abort(new CallError('timeout', `${name} 超过 ${timeoutMs} 毫秒没有回复`)),
        timeoutMs,
      )
      this.pending.add(abort)
      // roslib 不支持取消调用；超时后迟到的回复由 finish 忽略
      new Service({ ros: this.ros, name, serviceType: type }).callService(
        request,
        (response) => finish(() => resolve(response)),
        (error) => abort(new CallError('failed', `${name} 调用失败：${error}`)),
      )
    })
  }

  subscribe(name: string, type: string, onMessage: (message: unknown) => void): () => void {
    // 每次连接都新建 Ros 实例，不需要 roslib 在同一实例上重连后重新订阅
    const topic = new Topic({ ros: this.ros, name, messageType: type, reconnect_on_close: false })
    topic.subscribe(onMessage)
    return () => topic.unsubscribe()
  }

  onClose(listener: () => void): void {
    if (this.closed) listener()
    else this.closeListeners.push(listener)
  }

  close(): void {
    this.ros.close()
    this.handleClose()
  }

  private handleClose(): void {
    if (this.closed) return
    this.closed = true
    for (const abort of [...this.pending]) abort(new CallError('closed', '连接已关闭'))
    for (const listener of this.closeListeners.splice(0)) listener()
    this.ros.removeAllListeners()
  }
}

export const connectRoslib: Connect = (url, timeoutMs) =>
  new Promise((resolve, reject) => {
    const ros = new Ros({})
    let settled = false
    const fail = (message: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      ros.close()
      reject(new Error(message))
    }
    const timer = setTimeout(() => fail(`连接 ${url} 超时`), timeoutMs)
    ros.on('connection', () => {
      // 超时之后才打开的连接直接关闭
      if (settled) return ros.close()
      settled = true
      clearTimeout(timer)
      resolve(new RoslibSocket(ros))
    })
    ros.on('close', () => fail(`无法连接 ${url}`))
    // 出错之后总会关闭，由 close 处理
    ros.on('error', () => {})
    ros.connect(url).catch((error: unknown) => fail(`无法连接 ${url}：${String(error)}`))
  })
