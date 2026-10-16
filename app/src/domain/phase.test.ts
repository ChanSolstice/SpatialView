import { describe, expect, it } from 'vitest'
import { PHASES } from '../ros/contract.ts'
import { makeState, stateForPhase } from '../testing/fixtures.ts'
import {
  alarmSummary,
  cameraView,
  laserView,
  phaseView,
  progressPercent,
  robotNotice,
  robotView,
  sceneContent,
} from './phase.ts'

describe('状态显示', () => {
  it('未连接时全部显示未知（需求 5.2）', () => {
    for (const view of [robotView(null), laserView(null), cameraView(null)]) {
      expect(view).toEqual({ text: '未知', tone: 'gray' })
    }
    expect(phaseView(null)).toEqual({ text: '未知', known: false })
  })

  it('不认识的取值显示为未知（架构设计 4.2）', () => {
    const state = makeState({
      robot_state: 'TELEPORTING',
      laser_state: 'WARMING_UP',
      camera_state: 'BUSY',
      phase: 'CALIBRATING',
    })
    expect(robotView(state).text).toBe('未知')
    expect(laserView(state).text).toBe('未知')
    expect(cameraView(state).text).toBe('未知')
    expect(phaseView(state).known).toBe(false)
  })

  it('颜色与前端UI设计 3.2 一致', () => {
    const tone = (robot_state: string) => robotView(makeState({ robot_state })).tone
    expect(
      ['READY', 'RUNNING', 'PAUSED', 'FAULT', 'ESTOP', 'DISABLED', 'OFFLINE'].map(tone),
    ).toEqual(['ok', 'run', 'pause', 'fault', 'crit', 'off', 'gray'])
    const laser = (laser_state: string) => laserView(makeState({ laser_state })).tone
    expect(['OFF', 'ON', 'ERROR', 'OFFLINE'].map(laser)).toEqual(['off', 'laser', 'fault', 'gray'])
    const camera = (camera_state: string) => cameraView(makeState({ camera_state })).tone
    expect(['OK', 'ERROR', 'OFFLINE'].map(camera)).toEqual(['ok', 'fault', 'gray'])
  })
})

describe('alarmSummary', () => {
  it('按最高级别着色（需求 9.2）', () => {
    expect(alarmSummary([])).toEqual({ count: 0, text: '无告警', tone: 'none' })
    expect(alarmSummary(['WARNING', 'WARNING'])).toEqual({
      count: 2,
      text: '2 个告警',
      tone: 'pause',
    })
    expect(alarmSummary(['WARNING', 'ERROR']).tone).toBe('fault')
  })

  it('不认识的级别按错误处理', () => {
    expect(alarmSummary(['WARNING', 'CRITICAL']).tone).toBe('fault')
  })
})

describe('progressPercent', () => {
  it('只在服务端耗时阶段且提供进度时有值', () => {
    expect(progressPercent(stateForPhase('SCANNING', { progress: 42.4 }))).toBe(42)
    expect(progressPercent(stateForPhase('PLANNING', { progress: 100.2 }))).toBe(100)
    expect(progressPercent(stateForPhase('SCANNING', { progress: -1 }))).toBeNull()
    expect(progressPercent(stateForPhase('EXECUTING', { progress: 50 }))).toBeNull()
    expect(progressPercent(null)).toBeNull()
  })
})

describe('sceneContent：需求 6.3 的表格', () => {
  it.each([
    ['NO_MODEL', 'none', 'none', 'empty'],
    ['SCANNING', 'faded', 'none', 'progress'],
    ['RECONSTRUCTING', 'faded', 'none', 'progress'],
    ['MODEL_READY', 'normal', 'none', null],
    ['PLANNING', 'normal', 'none', 'progress'],
    ['PLAN_READY', 'normal', 'static', null],
    ['EXECUTING', 'normal', 'execution', null],
    ['PAUSED', 'normal', 'execution', null],
    ['STOPPING', 'normal', 'execution', null],
  ])('%s', (phase, workpiece, path, center) => {
    expect(sceneContent(phase, 'browse')).toEqual({ workpiece, path, robot: false, center })
  })

  it('表格覆盖全部阶段', () => {
    for (const phase of PHASES) expect(sceneContent(phase, 'browse').center).not.toBeUndefined()
  })

  it('选面模式：工件可点选，路径隐藏', () => {
    expect(sceneContent('PLAN_READY', 'select')).toEqual({
      workpiece: 'selectable',
      path: 'none',
      robot: false,
      center: null,
    })
  })

  it('轨迹动画模式：显示机械臂，路径按动画进度着色', () => {
    expect(sceneContent('PLAN_READY', 'animate')).toEqual({
      workpiece: 'normal',
      path: 'animation',
      robot: true,
      center: null,
    })
  })

  it('阶段未知时只显示工件', () => {
    expect(sceneContent(null, 'browse')).toEqual({
      workpiece: 'normal',
      path: 'none',
      robot: false,
      center: null,
    })
  })
})

describe('robotNotice：需求 5.6', () => {
  it('软件急停尚未复位', () => {
    const notice = robotNotice(makeState({ robot_state: 'ESTOP', software_estop: true }))
    expect(notice).toMatchObject({ kind: 'softwareEstop', reset: true })
  })

  it('设备急停', () => {
    expect(robotNotice(makeState({ robot_state: 'ESTOP' }))).toMatchObject({
      kind: 'deviceEstop',
      reset: false,
    })
  })

  it('未启动', () => {
    expect(robotNotice(makeState({ robot_state: 'DISABLED' }))?.kind).toBe('disabled')
  })

  it('故障、离线、就绪和未连接时没有提示', () => {
    for (const robot_state of ['FAULT', 'OFFLINE', 'READY', 'RUNNING', 'PAUSED']) {
      expect(robotNotice(makeState({ robot_state })), robot_state).toBeNull()
    }
    // 离线时即使驱动仍锁存，也只由告警说明
    expect(robotNotice(makeState({ robot_state: 'OFFLINE', software_estop: true }))).toBeNull()
    expect(robotNotice(null)).toBeNull()
  })
})
