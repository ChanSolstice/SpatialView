/**
 * 指令通道（架构设计 5.5）。
 *
 * - 普通指令：发出时加在途锁，回复或超时后解锁；超时或 rosbridge 返回调用失败时提示"服务端无响应"，
 *   被拒绝时按状态码提示。回复中的状态交给 stateSync。断线后到达的回复直接丢弃（需求 7.4）。
 * - 关闭激光：不受在途锁限制，也不加锁；超时、调用失败或被拒绝时显示安全警示（需求 8.2）。
 * - 急停：不受锁限制、不加锁，可以重复按；只要 WebSocket 打开就发送，不看连接状态；
 *   WebSocket 未打开、超时、调用失败或 success 为 false 时显示安全警示（需求 8.1）。
 */
import type { Config } from '../config/schema.ts'
import { isActionAvailable } from '../domain/availability.ts'
import { commandCodeText } from '../domain/codes.ts'
import type { CommandKey } from '../domain/types.ts'
import { selectAvailability } from '../store/selectors.ts'
import type { AppState, AppStore } from '../store/store.ts'
import { ESTOP_SERVICE, SERVICES, triggerResponseSchema, type WorkpieceType } from './contract.ts'
import type { StateSync } from './stateSync.ts'
import { CallError, type RosSocket } from './transport.ts'

export const NO_RESPONSE_TEXT = '服务端无响应，请检查连接'

export const ESTOP_FAILED = {
  title: '急停发送失败',
  text: '请立即使用设备急停按钮',
  disconnected: '与服务端的连接已断开，软件急停无法送达机械臂。',
  notApplied: '软件急停未生效。',
}

export const LASER_OFF_FAILED = {
  title: '激光关闭失败',
  text: '请立即使用设备急停按钮',
}

export interface CommandConnection {
  readonly current: RosSocket | null
  readonly epoch: number
}

export interface CommandOptions {
  /** 开始扫描时选择的工件类型（需求 5.4），开始扫描必须提供。 */
  workpieceType?: WorkpieceType
}

export interface Commands {
  /** 发送普通指令。不可用时不发送（防御检查，最终是否合法由服务端判断）。 */
  run(key: CommandKey, options?: CommandOptions): Promise<void>
  laserOff(): Promise<void>
  estop(): Promise<void>
}

interface Request {
  service: { name: string; type: string }
  args: object
}

/**
 * 指令的请求。模型和规划 ID 取 APP 当前加载的；本地尚未加载时取服务端当前的（接口文档 6.4、6.5）。
 * 开始扫描没有工件类型时返回 null，不发送。
 */
function request(key: CommandKey, s: AppState, options: CommandOptions): Request | null {
  const modelId = s.model.id ?? s.server?.model_id ?? ''
  const planId = s.plan.id ?? s.server?.plan_id ?? ''
  const task = (command: string, plan_id = '') => ({
    service: SERVICES.taskControl,
    args: { command, plan_id },
  })
  switch (key) {
    case 'scan':
      return options.workpieceType
        ? { service: SERVICES.startScan, args: { workpiece_type: options.workpieceType } }
        : null
    case 'plan':
      return {
        service: SERVICES.startPlan,
        args: { model_id: modelId, surface_ids: [...s.selection] },
      }
    case 'start':
      return task('START', planId)
    case 'pause':
      return task('PAUSE')
    case 'resume':
      return task('RESUME')
    case 'stop':
      return task('STOP')
    case 'laserOn':
      return { service: SERVICES.setLaser, args: { on: true } }
    case 'resetEstop':
      return { service: SERVICES.resetEstop, args: {} }
    case 'powerOn':
      return { service: SERVICES.powerOn, args: {} }
  }
}

/** 从回复中取出状态码和补充说明。结构不符时仍尽量取出，状态交给 stateSync 校验。 */
function reply(raw: unknown): { code: string | null; detail: string; state: unknown } {
  const value = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  return {
    code: typeof value.code === 'string' ? value.code : null,
    detail: typeof value.detail === 'string' ? value.detail : '',
    state: value.state,
  }
}

export function createCommands(
  store: AppStore,
  connection: CommandConnection,
  sync: StateSync,
  timing: Config['timing'],
): Commands {
  const toastError = (title: string, detail = '', code = '') =>
    store.getState().showToast({ tone: 'error', title, detail, code })

  const safety = (title: string, reason: string, detail = '', code = '') =>
    store.getState().pushDialog({
      kind: 'safety',
      title,
      text: title === ESTOP_FAILED.title ? ESTOP_FAILED.text : LASER_OFF_FAILED.text,
      reason,
      detail,
      code,
    })

  return {
    async run(key, options = {}) {
      const s = store.getState()
      if (!isActionAvailable(key, selectAvailability(s))) return
      const req = request(key, s, options)
      const socket = connection.current
      if (req === null || socket === null || !s.beginCommand(key)) return
      const epoch = connection.epoch
      const { service, args } = req
      try {
        const raw = await socket.call(service.name, service.type, args, timing.service_timeout_ms)
        if (connection.epoch !== epoch) return
        const { code, detail, state } = reply(raw)
        sync(state, 'command')
        if (code === null) {
          toastError(NO_RESPONSE_TEXT)
        } else if (code !== 'OK') {
          toastError(commandCodeText(code), detail, code)
        } else if (key === 'plan') {
          // 规划请求被接受后自动退出选面模式（需求 6.4）
          store.getState().setMode('browse')
        }
      } catch {
        if (connection.epoch === epoch) toastError(NO_RESPONSE_TEXT)
      } finally {
        if (connection.epoch === epoch) store.getState().endCommand(key)
      }
    },

    async laserOff() {
      const s = store.getState()
      if (!isActionAvailable('laserOff', selectAvailability(s))) return
      const socket = connection.current
      if (socket === null) return safety(LASER_OFF_FAILED.title, '')
      s.laserOffStarted()
      try {
        const { name, type } = SERVICES.setLaser
        const raw = await socket.call(name, type, { on: false }, timing.service_timeout_ms)
        const { code, detail, state } = reply(raw)
        sync(state, 'command')
        if (code === null) safety(LASER_OFF_FAILED.title, NO_RESPONSE_TEXT)
        else if (code !== 'OK') safety(LASER_OFF_FAILED.title, commandCodeText(code), detail, code)
      } catch {
        safety(LASER_OFF_FAILED.title, NO_RESPONSE_TEXT)
      } finally {
        store.getState().laserOffFinished()
      }
    },

    async estop() {
      const socket = connection.current
      if (socket === null || !socket.isOpen) {
        return safety(ESTOP_FAILED.title, ESTOP_FAILED.disconnected)
      }
      try {
        const raw = await socket.call(
          ESTOP_SERVICE.name,
          ESTOP_SERVICE.type,
          {},
          timing.estop_timeout_ms,
        )
        const parsed = triggerResponseSchema.safeParse(raw)
        if (!parsed.success || !parsed.data.success)
          safety(ESTOP_FAILED.title, ESTOP_FAILED.notApplied)
      } catch (error) {
        const closed = error instanceof CallError && error.failure === 'closed'
        safety(ESTOP_FAILED.title, closed ? ESTOP_FAILED.disconnected : ESTOP_FAILED.notApplied)
      }
    },
  }
}
