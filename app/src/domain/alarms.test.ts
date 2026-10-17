import { describe, expect, it } from 'vitest'
import { alarmItems, formatAlarmTime, LOCAL_ALARMS, updateLocalAlarms } from './alarms.ts'

describe('updateLocalAlarms', () => {
  it('新成立的记下开始时刻，仍然成立的保留开始时刻，不再成立的移除', () => {
    const a = updateLocalAlarms([], { APP_NETWORK_DOWN: '' }, 1000)
    expect(a).toEqual([{ code: 'APP_NETWORK_DOWN', detail: '', since: 1000 }])
    const b = updateLocalAlarms(
      a,
      { APP_NETWORK_DOWN: '', APP_MODEL_LOAD_FAILED: 'HTTP 404' },
      2000,
    )
    expect(b).toEqual([
      { code: 'APP_NETWORK_DOWN', detail: '', since: 1000 },
      { code: 'APP_MODEL_LOAD_FAILED', detail: 'HTTP 404', since: 2000 },
    ])
    expect(updateLocalAlarms(b, { APP_MODEL_LOAD_FAILED: 'HTTP 404' }, 3000)).toEqual([
      { code: 'APP_MODEL_LOAD_FAILED', detail: 'HTTP 404', since: 2000 },
    ])
  })

  it('没有变化时返回原数组；补充说明变化时更新，开始时刻不变', () => {
    const a = updateLocalAlarms([], { APP_PLAN_LOAD_FAILED: 'x' }, 1000)
    expect(updateLocalAlarms(a, { APP_PLAN_LOAD_FAILED: 'x' }, 5000)).toBe(a)
    expect(updateLocalAlarms(a, { APP_PLAN_LOAD_FAILED: 'y' }, 5000)).toEqual([
      { code: 'APP_PLAN_LOAD_FAILED', detail: 'y', since: 1000 },
    ])
  })
})

describe('alarmItems', () => {
  const server = [
    {
      code: 'ROBOT_FAULT',
      level: 'ERROR',
      detail: '第 3 轴过温',
      stamp: { sec: 100, nanosec: 500_000_000 },
    },
    { code: 'PLAN_FAILED', level: 'WARNING', detail: '', stamp: { sec: 300, nanosec: 0 } },
    { code: 'VENDOR_X', level: 'FATAL', detail: '未知', stamp: { sec: 50, nanosec: 0 } },
  ]

  it('服务端告警和本地告警合在一起，按时间倒序', () => {
    const items = alarmItems(server, [{ code: 'APP_NETWORK_DOWN', detail: '', since: 200_000 }])
    expect(items.map((i) => [i.code, i.time])).toEqual([
      ['PLAN_FAILED', 300_000],
      ['APP_NETWORK_DOWN', 200_000],
      ['ROBOT_FAULT', 100_500],
      ['VENDOR_X', 50_000],
    ])
  })

  it('名称：服务端告警按告警码给出，未知的为"设备告警"；本地告警取本地定义；不认识的级别按错误', () => {
    const items = alarmItems(server, [{ code: 'APP_PLAN_ROBOT_MISMATCH', detail: 'J1', since: 0 }])
    const byCode = Object.fromEntries(items.map((i) => [i.code, i]))
    expect(byCode.ROBOT_FAULT).toMatchObject({ name: '机械臂故障', level: 'ERROR', local: false })
    expect(byCode.VENDOR_X).toMatchObject({ name: '设备告警', level: 'ERROR' })
    expect(byCode.APP_PLAN_ROBOT_MISMATCH).toMatchObject({
      name: '规划数据与机械臂模型不匹配',
      level: 'WARNING',
      local: true,
    })
  })

  it('本地告警的名称与需求 9.1 一致', () => {
    expect(Object.values(LOCAL_ALARMS).map((a) => a.name)).toEqual([
      '网络连接断开',
      '服务端无响应',
      '模型加载失败',
      '规划加载失败',
      '接口版本不匹配',
      '规划数据与机械臂模型不匹配',
    ])
  })
})

describe('formatAlarmTime', () => {
  it('时:分:秒', () => {
    const ms = new Date(2026, 9, 16, 9, 5, 7).getTime()
    expect(formatAlarmTime(ms)).toBe('09:05:07')
  })
})
