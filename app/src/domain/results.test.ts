import { describe, expect, it } from 'vitest'
import { EMPTY_RESULT } from '../testing/fixtures.ts'
import { nextResult, resultNotice } from './results.ts'

const result = (operation: string, outcome: string, code = '', detail = '') => ({
  ...EMPTY_RESULT,
  id: 'session-a-1',
  operation,
  result: outcome,
  code,
  detail,
})

describe('resultNotice：接口文档 8.7 的组合', () => {
  it.each([
    ['SCAN', 'FAILED', 'NO_VALID_DATA', '扫描失败', 'error', '未获得有效的扫描数据'],
    ['SCAN', 'INTERRUPTED', 'CAMERA_OFFLINE', '扫描已中断', 'error', '相机离线'],
    ['RECONSTRUCT', 'FAILED', 'RECONSTRUCT_ERROR', '重建失败', 'error', '三维重建失败'],
    ['PLAN', 'FAILED', 'NO_SOLUTION', '规划失败', 'error', '所选表面均无法生成清洗路径'],
    [
      'PLAN',
      'SUCCEEDED',
      'PLAN_PARTIAL',
      '部分表面未能规划',
      'partial',
      '部分表面无法生成清洗路径，未包含在本次规划中',
    ],
    ['TASK', 'SUCCEEDED', '', '清洗完成', 'success', ''],
    ['TASK', 'INTERRUPTED', 'ROBOT_ESTOP', '清洗已中断', 'error', '机械臂急停'],
  ])('%s %s %s', (operation, outcome, code, title, tone, reason) => {
    expect(resultNotice(result(operation, outcome, code, '第 3 轴过载'))).toEqual({
      title,
      tone,
      reason,
      detail: '第 3 轴过载',
      code,
    })
  })

  it.each([
    ['RECONSTRUCT', 'SUCCEEDED'],
    ['PLAN', 'SUCCEEDED'],
    ['TASK', 'STOPPED'],
  ])('%s %s 不弹框', (operation, outcome) => {
    expect(resultNotice(result(operation, outcome))).toBeNull()
  })

  it('不在组合中的失败和中断给出通用标题，原因码不认识时显示未知原因', () => {
    expect(resultNotice(result('CALIBRATE', 'FAILED', 'LENS_DIRTY'))).toMatchObject({
      title: '操作失败',
      reason: '未知原因',
      code: 'LENS_DIRTY',
    })
    expect(resultNotice(result('CALIBRATE', 'INTERRUPTED'))?.title).toBe('操作已中断')
    expect(resultNotice(result('TASK', 'FAILED'))?.title).toBe('清洗失败')
    expect(resultNotice(result('TASK', 'CANCELLED'))).toBeNull()
  })
})

describe('nextResult：按 last_result.id 判断（需求 5.5）', () => {
  const failed = result('PLAN', 'FAILED', 'NO_SOLUTION')

  it('APP 启动后的第一份状态只记录 id、不弹框', () => {
    expect(nextResult(null, failed)).toEqual({ id: failed.id, notice: null })
  })

  it('id 不变不弹框', () => {
    expect(nextResult(failed.id, failed).notice).toBeNull()
  })

  it('id 变化时弹框', () => {
    expect(nextResult('session-a-0', failed).notice?.title).toBe('规划失败')
  })

  it('id 为空（本会话还没有结果）时记录为空、不弹框', () => {
    expect(nextResult('session-a-0', EMPTY_RESULT)).toEqual({ id: '', notice: null })
  })
})
