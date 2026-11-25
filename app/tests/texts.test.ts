/**
 * 显示文字与文档一致：状态码文字（接口文档第 7 节的"APP 显示"列）、状态显示（需求 4、5.2）、
 * 结果提示框标题和规划范围的说明（需求 5.5）、机械臂提示（需求 5.6）、本地告警（需求 9.1）。
 */
import { describe, expect, it } from 'vitest'
import { LOCAL_ALARMS } from '../src/domain/alarms.ts'
import {
  ALARM_CODE_TEXT,
  COMMAND_CODE_TEXT,
  RESULT_CODE_TEXT,
  UNKNOWN_ALARM_TEXT,
  UNKNOWN_COMMAND_TEXT,
  UNKNOWN_RESULT_TEXT,
} from '../src/domain/codes.ts'
import {
  CAMERA_VIEW,
  LASER_VIEW,
  PHASE_TEXT,
  ROBOT_NOTICES,
  ROBOT_VIEW,
  SERVICE_VIEW,
} from '../src/domain/phase.ts'
import { EXPANDED_TITLE, rangeLines } from '../src/domain/planRange.ts'
import { resultNotice } from '../src/domain/results.ts'
import { EMPTY_RESULT } from '../src/testing/fixtures.ts'
import { code, column, readDoc, section, table } from './docs.ts'

const requirements = readDoc('需求文档.md')
const interfaceDoc = readDoc('服务端对接接口文档.md')

/** 接口文档第 7 节某个表格的"APP 显示"列，以状态码为键；第一列不是状态码的行（空、设备专用告警）不计。 */
function displayed(number: string): Record<string, string> {
  const entries = [...column(table(interfaceDoc, number), 'APP 显示')]
    .filter(([key]) => key.startsWith('`'))
    .map(([key, text]) => [code(key), text])
  return Object.fromEntries(entries)
}

describe('接口文档第 7 节的状态码文字', () => {
  it('7.1 指令状态码', () => {
    expect(displayed('7.1')).toEqual({ ...COMMAND_CODE_TEXT, OK: '不提示' })
  })

  it('7.2 操作结果原因码', () => {
    expect(displayed('7.2')).toEqual(RESULT_CODE_TEXT)
  })

  it('7.3 告警码', () => {
    expect(displayed('7.3')).toEqual(ALARM_CODE_TEXT)
  })

  it('7.4 未知状态码的通用文字', () => {
    const text = section(interfaceDoc, '7.4')
    for (const generic of [UNKNOWN_COMMAND_TEXT, UNKNOWN_RESULT_TEXT, UNKNOWN_ALARM_TEXT]) {
      expect(text).toContain(`"${generic}"`)
    }
  })
})

describe('需求第 4 节的状态显示', () => {
  it('4.1 机械臂状态', () => {
    const shown = column(table(requirements, '4.1'), '显示')
    expect(Object.fromEntries(shown)).toEqual(
      Object.fromEntries(Object.entries(ROBOT_VIEW).map(([value, view]) => [value, view.text])),
    )
  })

  it('4.2 激光器、相机状态', () => {
    const laser = column(table(requirements, '4.2', 0), '显示')
    const camera = column(table(requirements, '4.2', 1), '显示')
    expect(Object.fromEntries(laser)).toEqual(
      Object.fromEntries(Object.entries(LASER_VIEW).map(([value, view]) => [value, view.text])),
    )
    expect(Object.fromEntries(camera)).toEqual(
      Object.fromEntries(Object.entries(CAMERA_VIEW).map(([value, view]) => [value, view.text])),
    )
  })

  it('4.3 作业阶段', () => {
    expect(Object.fromEntries(column(table(requirements, '4.3'), '显示'))).toEqual(PHASE_TEXT)
  })
})

describe('需求 5.2 的 Status Bar', () => {
  const t = table(requirements, '5.2')
  const contentOf = (area: string) => column(t, '显示内容').get(area) ?? ''
  const colorOf = (area: string) => column(t, '颜色').get(area) ?? ''

  it('机械臂的文字与颜色顺序一致', () => {
    const texts = contentOf('机械臂').split(' / ')
    expect(texts).toEqual(Object.values(ROBOT_VIEW).map((view) => view.text))
    // 颜色列与文字一一对应：绿 / 蓝 / 黄 / 红 / 红底白字 / 灰 / 灰
    const tones = {
      绿: 'ok',
      蓝: 'run',
      黄: 'pause',
      红: 'fault',
      红底白字: 'crit',
      灰: ['off', 'gray'],
    }
    colorOf('机械臂')
      .split(' / ')
      .forEach((color, i) => {
        const expected = tones[color as keyof typeof tones]
        expect([expected].flat()).toContain(Object.values(ROBOT_VIEW)[i]?.tone)
      })
  })

  it('服务的三种状态', () => {
    const texts = contentOf('服务').split('；')[0]?.split(' / ')
    expect(texts).toEqual([
      SERVICE_VIEW.connected.text,
      SERVICE_VIEW.connecting.text,
      SERVICE_VIEW.reconnecting.text,
    ])
  })
})

describe('需求 5.5 的结果提示框标题', () => {
  const titles = [...column(table(requirements, '5.5'), '提示框标题').values()].flatMap((cell) =>
    cell.split(' / '),
  )

  it.each([
    ['TASK', 'SUCCEEDED', ''],
    ['TASK', 'INTERRUPTED', 'ROBOT_ESTOP'],
    ['SCAN', 'INTERRUPTED', 'CAMERA_OFFLINE'],
    ['SCAN', 'FAILED', 'NO_VALID_DATA'],
    ['RECONSTRUCT', 'FAILED', 'RECONSTRUCT_ERROR'],
    ['PLAN', 'FAILED', 'NO_SOLUTION'],
    ['PLAN', 'SUCCEEDED', 'PLAN_PARTIAL'],
    ['POWER_ON', 'FAILED', 'ROBOT_ESTOP'],
  ])('%s %s %s', (operation, result, reason) => {
    const notice = resultNotice({ ...EMPTY_RESULT, id: 'r', operation, result, code: reason })
    expect(titles).toContain(notice?.title)
  })

  it('表中的每个标题都会用到', () => {
    expect(titles).toEqual([
      '清洗完成',
      '清洗已中断',
      '扫描已中断',
      '扫描失败',
      '重建失败',
      '规划失败',
      '上电失败',
      '部分路径未能规划',
      EXPANDED_TITLE,
    ])
  })

  it('规划范围的说明与需求一致（数字换成需求中的 N、M、F）', () => {
    const lines = rangeLines({
      selected: 7,
      scope: 8,
      expanded: new Set(['a']),
      untraced: new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']),
    }).map((line) => line.replace('7', 'N').replace('8', 'M').replace('9', 'F'))
    expect(lines).toHaveLength(2)
    const text = section(requirements, '5.5')
    for (const line of lines) expect(text).toContain(`"${line}"`)
  })

  it('上电成功不弹提示框', () => {
    expect(
      resultNotice({ ...EMPTY_RESULT, id: 'r', operation: 'POWER_ON', result: 'SUCCEEDED' }),
    ).toBeNull()
  })
})

describe('需求 5.6 的机械臂提示', () => {
  const t = table(requirements, '5.6')

  it('标题、说明和按钮与需求一致', () => {
    const notices = [
      ROBOT_NOTICES.softwareEstop,
      ROBOT_NOTICES.deviceEstop,
      ROBOT_NOTICES.disabled,
      ROBOT_NOTICES.starting,
    ]
    expect(t.rows.map(([, title, text, button]) => ({ title, text, button }))).toEqual(
      notices.map((notice) => ({
        title: notice.title,
        text: notice.text,
        button: notice.reset ? '复位急停' : '—',
      })),
    )
  })
})

describe('需求 9.1 的本地告警', () => {
  it('名称、告警码和级别与需求一致', () => {
    const rows = table(requirements, '9.1', 1)
    expect(rows.header).toEqual(['告警', 'code', 'level', '补充说明'])
    expect(rows.rows.map(([name, key, level]) => [code(key ?? ''), name, level])).toEqual(
      Object.entries(LOCAL_ALARMS).map(([key, alarm]) => [key, alarm.name, alarm.level]),
    )
  })
})
