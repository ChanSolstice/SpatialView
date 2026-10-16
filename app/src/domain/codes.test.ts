import { describe, expect, it } from 'vitest'
import { ALARM_CODES, COMMAND_CODES, RESULT_CODES } from '../ros/contract.ts'
import { alarmCodeText, commandCodeText, isKnownCode, resultCodeText } from './codes.ts'

describe('codes', () => {
  it('每个状态码都有文字（接口文档第 7 节）', () => {
    for (const code of COMMAND_CODES.filter((c) => c !== 'OK')) {
      expect(commandCodeText(code), code).not.toBe('')
    }
    for (const code of RESULT_CODES) expect(resultCodeText(code), code).not.toBe('')
    for (const code of ALARM_CODES) expect(alarmCodeText(code), code).not.toBe('')
  })

  it('未知状态码显示通用文字（接口文档 7.4）', () => {
    expect(commandCodeText('NEW_CODE')).toBe('操作被拒绝')
    expect(resultCodeText('NEW_CODE')).toBe('未知原因')
    expect(alarmCodeText('LASER_COOLING')).toBe('设备告警')
    expect(isKnownCode('LASER_COOLING')).toBe(false)
    expect(isKnownCode('INTERLOCK')).toBe(true)
  })

  it('原因码为空表示没有需要说明的原因', () => {
    expect(resultCodeText('')).toBe('')
  })

  it('不把对象原型上的属性当作状态码', () => {
    expect(commandCodeText('toString')).toBe('操作被拒绝')
    expect(alarmCodeText('__proto__')).toBe('设备告警')
  })
})
