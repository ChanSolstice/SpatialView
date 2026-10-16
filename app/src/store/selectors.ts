/**
 * 由 store 计算出的界面数据。按钮可用性不存进 store，每次由这里调用 domain 计算（架构设计 5.2）。
 * 计算结果按输入缓存，输入不变时返回同一个对象，React 组件订阅时不会重复渲染。
 */
import { availability, type Availability } from '../domain/availability.ts'
import { alarmSummary, type AlarmSummary } from '../domain/phase.ts'
import { isCompatibleVersion, unknownValues, type SystemState } from '../ros/contract.ts'
import type { AppState } from './store.ts'

function memo<A extends readonly unknown[], R>(
  inputs: (s: AppState) => A,
  compute: (...args: [...A]) => R,
): (s: AppState) => R {
  let last: A | null = null
  let result: R
  return (s) => {
    const args = inputs(s)
    if (last === null || args.some((arg, i) => !Object.is(arg, last?.[i]))) {
      last = args
      result = compute(...args)
    }
    return result
  }
}

/** 已连接时的服务端状态；未连接时 Status Bar 显示"未知"，按钮按未连接处理（需求 5.2、5.3）。 */
export function liveState(s: AppState): SystemState | null {
  return s.conn.status === 'connected' ? s.server : null
}

export type InterfaceIssue =
  | { kind: 'schema'; detail: string }
  | { kind: 'version'; detail: string }
  | { kind: 'value'; detail: string }

/** 接口不匹配的原因（需求 7.7；架构设计 4.2）；为 null 表示一致。 */
export const selectInterfaceIssue = memo(
  (s) => [s.contractError, s.server] as const,
  (contractError, server): InterfaceIssue | null => {
    if (contractError !== null) return { kind: 'schema', detail: contractError }
    if (server === null) return null
    if (!isCompatibleVersion(server.interface_version)) {
      return { kind: 'version', detail: server.interface_version }
    }
    const unknown = unknownValues(server)
    return unknown.length > 0 ? { kind: 'value', detail: unknown.join('，') } : null
  },
)

export const selectAvailability = memo(
  (s) =>
    [
      s.conn.status,
      liveState(s),
      selectInterfaceIssue(s),
      s.inflight,
      s.laserOffPending,
      s.mode,
      s.selection,
      s.model.status,
      s.plan.status,
    ] as const,
  (status, state, issue, inflight, laserOffPending, mode, selection, model, plan): Availability =>
    availability({
      connected: status === 'connected',
      state,
      interfaceOk: issue === null,
      inflight,
      laserOffPending: laserOffPending > 0,
      mode,
      selectionSize: selection.size,
      model,
      plan,
      // 规划解析和关节名检查在阶段 8 实现，在此之前轨迹动画不可用
      animationReady: false,
    }),
)

/** Status Bar 的告警按钮。断线期间保留断线前的服务端告警（需求 7.4）；本地告警在阶段 10 加入。 */
export const selectAlarmSummary = memo(
  (s) => [s.server] as const,
  (server): AlarmSummary => alarmSummary(server?.alarms.map((alarm) => alarm.level) ?? []),
)
