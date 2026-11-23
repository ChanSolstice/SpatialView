/**
 * 告警面板的条目（需求 9；前端UI设计 4.6）：服务端告警和 APP 本地告警合在一起，按时间倒序。
 * 本地告警的告警码以 APP_ 开头，与服务端的告警码（接口文档 7.3）区分。
 */
import type { Alarm, AlarmLevel } from '../ros/contract.ts'
import { alarmCodeText } from './codes.ts'

/** APP 本地告警（需求 9.1），条件不再成立时消失。 */
export const LOCAL_ALARMS = {
  APP_NETWORK_DOWN: { name: '网络连接断开', level: 'ERROR' },
  APP_SERVER_NO_RESPONSE: { name: '服务端无响应', level: 'ERROR' },
  APP_MODEL_LOAD_FAILED: { name: '模型加载失败', level: 'ERROR' },
  APP_PLAN_LOAD_FAILED: { name: '规划加载失败', level: 'ERROR' },
  APP_INTERFACE_MISMATCH: { name: '接口版本不匹配', level: 'ERROR' },
  APP_PLAN_ROBOT_MISMATCH: { name: '规划数据与机械臂模型不匹配', level: 'WARNING' },
  APP_MODEL_OVERSIZE: { name: '模型超出规模约定', level: 'WARNING' },
} as const satisfies Record<string, { name: string; level: AlarmLevel }>

export type LocalAlarmCode = keyof typeof LOCAL_ALARMS

export interface LocalAlarm {
  code: LocalAlarmCode
  detail: string
  /** 条件开始成立的时刻，Unix 毫秒（平板时间） */
  since: number
}

/** 当前成立的本地告警：code 到补充说明。 */
export type LocalConditions = Partial<Record<LocalAlarmCode, string>>

/**
 * 按当前条件更新本地告警：仍然成立的保留开始时刻，新成立的记为 now，不再成立的移除。
 * 结果与 previous 相同时返回 previous，便于判断是否需要写入 store。
 */
export function updateLocalAlarms(
  previous: readonly LocalAlarm[],
  conditions: LocalConditions,
  now: number,
): readonly LocalAlarm[] {
  const next: LocalAlarm[] = []
  for (const code of Object.keys(LOCAL_ALARMS) as LocalAlarmCode[]) {
    const detail = conditions[code]
    if (detail === undefined) continue
    const old = previous.find((alarm) => alarm.code === code)
    next.push({ code, detail, since: old?.since ?? now })
  }
  const same =
    next.length === previous.length &&
    next.every((alarm, i) => {
      const old = previous[i]
      return old?.code === alarm.code && old.detail === alarm.detail
    })
  return same ? previous : next
}

export interface AlarmItem {
  code: string
  /** 不认识的级别按错误显示，宁可醒目 */
  level: 'ERROR' | 'WARNING'
  name: string
  detail: string
  /** 发生时间，Unix 毫秒：服务端告警为服务端时间，本地告警为平板时间 */
  time: number
  local: boolean
}

/** 面板中的条目，按时间倒序。 */
export function alarmItems(server: readonly Alarm[], local: readonly LocalAlarm[]): AlarmItem[] {
  const items: AlarmItem[] = [
    ...server.map((alarm) => ({
      code: alarm.code,
      level: alarm.level === 'WARNING' ? ('WARNING' as const) : ('ERROR' as const),
      name: alarmCodeText(alarm.code),
      detail: alarm.detail,
      time: alarm.stamp.sec * 1000 + Math.floor(alarm.stamp.nanosec / 1e6),
      local: false,
    })),
    ...local.map((alarm) => ({
      code: alarm.code,
      level: LOCAL_ALARMS[alarm.code].level,
      name: LOCAL_ALARMS[alarm.code].name,
      detail: alarm.detail,
      time: alarm.since,
      local: true,
    })),
  ]
  return items.sort((a, b) => b.time - a.time)
}

/** 告警时间：时:分:秒，按平板的时区显示。 */
export function formatAlarmTime(ms: number): string {
  const date = new Date(ms)
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((v) => String(v).padStart(2, '0'))
    .join(':')
}
