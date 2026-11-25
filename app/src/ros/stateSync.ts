/**
 * 服务端状态进入 store 的唯一入口（架构设计 5.4）：Topic、GetSystemState、指令回复都经过这里。
 * 模型和规划的下载不在这里触发，由 assets 模块订阅 server.model_id、server.plan_id 处理。
 */
import { nextResult } from '../domain/results.ts'
import { orderState } from '../domain/stateOrder.ts'
import type { AppStore } from '../store/store.ts'
import { systemStateSchema, type SystemState } from './contract.ts'

export const RESTART_NOTICE = {
  title: '服务端已重启',
  text: '服务端已重启，原模型和规划已失效，请重新扫描',
}

export type StateSource = 'get' | 'topic' | 'command'

export type StateSync = (raw: unknown, source: StateSource) => SystemState | null

export interface StateSyncOptions {
  /** 把激光器视为已连接（需求 10.2 的 integration.assume_laser_connected），见 assumeLaserConnected。 */
  assumeLaserConnected?: boolean
}

/**
 * 把激光器视为已连接：服务端与激光器的通信完成前的联调设置（需求 10.2）。laser_state 为 OFFLINE 时
 * 按 OFF 处理，去掉 LASER_OFFLINE 告警；其他取值不变。APP 中读取激光器状态的地方（Status Bar、
 * 按钮、开始清洗的警告、告警）都取写入 store 的状态，在这里改一处即可。
 */
export function assumeLaserConnected(state: SystemState): SystemState {
  const alarms = state.alarms.filter((alarm) => alarm.code !== 'LASER_OFFLINE')
  if (state.laser_state !== 'OFFLINE' && alarms.length === state.alarms.length) return state
  return {
    ...state,
    laser_state: state.laser_state === 'OFFLINE' ? 'OFF' : state.laser_state,
    alarms,
  }
}

/** 返回被接受的状态；校验失败或是旧消息时返回 null。 */
export function createStateSync(store: AppStore, options: StateSyncOptions = {}): StateSync {
  return (raw, source) => {
    const s = store.getState()
    // 1. 校验。失败视为接口不匹配，产生本地告警（架构设计 4.2）
    const parsed = systemStateSchema.safeParse(raw)
    if (!parsed.success) {
      const field = parsed.error.issues[0]?.path.join('.') || '消息结构'
      s.setContractError(`${source === 'topic' ? '状态消息' : '服务回复'}不符合接口约定：${field}`)
      return null
    }
    const state = options.assumeLaserConnected ? assumeLaserConnected(parsed.data) : parsed.data

    // 2、3. session_id 变化时接受并提示服务端重启；同一会话中丢弃旧消息（需求 7.5、7.6）
    const order = orderState(s.conn, state.session_id, state.seq)
    if (order === 'stale') return null
    if (order === 'restarted' && (s.model.id !== null || (s.server?.model_id ?? '') !== '')) {
      s.pushDialog({ kind: 'info', ...RESTART_NOTICE })
    }

    // 4. 接口版本由 selector 按 server.interface_version 检查（需求 7.7）
    // 5. 写入
    s.setServer(state, { sessionId: state.session_id, seq: state.seq })
    if (s.contractError !== null) s.setContractError(null)

    // 6. 操作结果提示框（需求 5.5）。规划成功时记下 plan_id，规划加载后说明规划范围（store/listeners.ts）
    const { id, notice } = nextResult(s.lastResultId, state.last_result)
    const fresh = id !== s.lastResultId && s.lastResultId !== null && id !== ''
    const result = state.last_result
    const planId =
      fresh && result.operation === 'PLAN' && result.result === 'SUCCEEDED' && state.plan_id !== ''
        ? state.plan_id
        : null
    if (id !== s.lastResultId) s.setLastResultId(id)
    if (planId !== null) s.setPlanNotice(planId)
    if (notice !== null) {
      s.pushDialog({ kind: 'result', notice: planId !== null ? { ...notice, planId } : notice })
    }
    return state
  }
}
