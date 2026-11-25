/**
 * 由 store 计算出的界面数据。按钮可用性不存进 store，每次由这里调用 domain 计算（架构设计 5.2）。
 * 计算结果按输入缓存，输入不变时返回同一个对象，React 组件订阅时不会重复渲染。
 */
import type { LoadedPlan } from '../assets/path.ts'
import type { LoadedRobot } from '../assets/robot.ts'
import { alarmItems, type AlarmItem } from '../domain/alarms.ts'
import { availability, type Availability } from '../domain/availability.ts'
import { planRange, type PlanRange } from '../domain/planRange.ts'
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

/** 轨迹动画所需的数据（需求 6.6）：规划和机械臂都已加载，关节名一致。 */
export interface AnimationData {
  plan: LoadedPlan
  robot: LoadedRobot
  /** 规划文件中每个关节对应的 URDF 关节名 */
  joints: string[]
}

const selectJointMatch = memo(
  (s) => [s.plan.data, s.robot.data] as const,
  (plan, robot) => (plan && robot ? { plan, robot, ...robot.match(plan.data.jointNames) } : null),
)

export const selectAnimationData = memo(
  (s) => [selectJointMatch(s)] as const,
  (match): AnimationData | null =>
    match && match.missing.length === 0
      ? { plan: match.plan, robot: match.robot, joints: match.joints }
      : null,
)

/**
 * 当前规划的规划范围（需求 6.4）：规划已加载、是服务端当前的规划，并且规划文件带有表面集合时才有。
 */
export const selectPlanRange = memo(
  (s) => [s.plan.data, s.server?.plan_id] as const,
  (plan, planId): PlanRange | null =>
    plan && plan.id === planId ? planRange(plan.data.scope, plan.data.surfaceIds) : null,
)

/**
 * 规划文件中有、机械臂模型中没有的关节（本地告警"规划数据与机械臂模型不匹配"，需求 6.6、9.1）；
 * 为 null 表示一致，或规划、机械臂还没有加载。
 */
export const selectJointMismatch = memo(
  (s) => [selectJointMatch(s)] as const,
  (match): string | null => (match && match.missing.length > 0 ? match.missing.join('，') : null),
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
      selectAnimationData(s),
    ] as const,
  (
    status,
    state,
    issue,
    inflight,
    laserOffPending,
    mode,
    selection,
    model,
    plan,
    animation,
  ): Availability =>
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
      animationReady: animation !== null,
    }),
)

/** 告警面板的条目：断线期间保留断线前的服务端告警（需求 7.4），加上本地告警。 */
export const selectAlarmItems = memo(
  (s) => [s.server, s.localAlarms] as const,
  (server, local): AlarmItem[] => alarmItems(server?.alarms ?? [], local),
)

/** Status Bar 的告警按钮：数量和最高级别包含本地告警（需求 9.2）。 */
export const selectAlarmSummary = memo(
  (s) => [selectAlarmItems(s)] as const,
  (items): AlarmSummary => alarmSummary(items.map((item) => item.level)),
)
