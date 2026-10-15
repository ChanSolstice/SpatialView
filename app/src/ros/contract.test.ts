import { describe, expect, it } from 'vitest'
import {
  commandResponseSchema,
  isCompatibleVersion,
  isOneOf,
  PHASES,
  systemStateSchema,
  type SystemState,
} from './contract.ts'

const state: SystemState = {
  interface_version: '1.0',
  session_id: 's1',
  seq: 1,
  stamp: { sec: 1, nanosec: 0 },
  robot_state: 'READY',
  software_estop: false,
  camera_state: 'OK',
  laser_state: 'OFF',
  phase: 'NO_MODEL',
  progress: -1,
  exec_time: 0,
  model_id: '',
  model_url: '',
  plan_id: '',
  plan_url: '',
  plan_surface_ids: [],
  alarms: [],
  last_result: {
    id: '',
    operation: '',
    result: '',
    code: '',
    detail: '',
    stamp: { sec: 0, nanosec: 0 },
  },
}

describe('isCompatibleVersion', () => {
  it('只比较主版本号', () => {
    expect(isCompatibleVersion('1.0')).toBe(true)
    expect(isCompatibleVersion('1.7')).toBe(true)
    expect(isCompatibleVersion('2.0')).toBe(false)
    expect(isCompatibleVersion('')).toBe(false)
    expect(isCompatibleVersion('1')).toBe(false)
  })
})

describe('isOneOf', () => {
  it('识别枚举取值', () => {
    expect(isOneOf(PHASES, 'PLAN_READY')).toBe(true)
    expect(isOneOf(PHASES, 'CALIBRATING')).toBe(false)
  })
})

describe('systemStateSchema', () => {
  it('接受合法的状态，忽略多出的字段', () => {
    const parsed = systemStateSchema.parse({ ...state, added_in_1_1: 'x' })
    expect(parsed).toEqual(state)
  })

  it('不认识的枚举取值不算接口不匹配', () => {
    expect(systemStateSchema.safeParse({ ...state, phase: 'CALIBRATING' }).success).toBe(true)
  })

  it('缺少字段或类型不对时拒绝', () => {
    const { software_estop: _omitted, ...missing } = state
    expect(systemStateSchema.safeParse(missing).success).toBe(false)
    expect(systemStateSchema.safeParse({ ...state, seq: '1' }).success).toBe(false)
    expect(systemStateSchema.safeParse({ ...state, alarms: [{ code: 'X' }] }).success).toBe(false)
  })
})

describe('commandResponseSchema', () => {
  it('包含状态码、补充说明和完整状态', () => {
    expect(commandResponseSchema.safeParse({ code: 'OK', detail: '', state }).success).toBe(true)
    expect(commandResponseSchema.safeParse({ code: 'OK', state }).success).toBe(false)
  })
})
