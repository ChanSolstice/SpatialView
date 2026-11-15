/**
 * 状态的显示文字与颜色（需求 4、5.2；前端UI设计 3.2）、各阶段的场景内容（需求 6.3）和机械臂提示（需求 5.6）。
 * 不认识的取值（例如服务端新增的阶段）显示为"未知"（架构设计 4.2）。
 */
import {
  isOneOf,
  CAMERA_STATES,
  LASER_STATES,
  PHASES,
  ROBOT_STATES,
  type CameraState,
  type LaserState,
  type Phase,
  type RobotState,
  type SystemState,
} from '../ros/contract.ts'
import type { ConnStatus, SceneMode } from './types.ts'

/** 状态胶囊的颜色，对应前端UI设计 3.1 的状态色。 */
export type Tone = 'ok' | 'run' | 'pause' | 'fault' | 'laser' | 'off' | 'gray' | 'crit'

export interface StatusView {
  text: string
  tone: Tone
}

export const UNKNOWN_TEXT = '未知'
const UNKNOWN: StatusView = { text: UNKNOWN_TEXT, tone: 'gray' }

export const ROBOT_VIEW: Record<RobotState, StatusView> = {
  READY: { text: '就绪', tone: 'ok' },
  RUNNING: { text: '运行中', tone: 'run' },
  PAUSED: { text: '暂停', tone: 'pause' },
  FAULT: { text: '故障', tone: 'fault' },
  ESTOP: { text: '急停', tone: 'crit' },
  DISABLED: { text: '未启动', tone: 'off' },
  STARTING: { text: '启动中', tone: 'pause' },
  OFFLINE: { text: '离线', tone: 'gray' },
}

export const LASER_VIEW: Record<LaserState, StatusView> = {
  OFF: { text: '关闭', tone: 'off' },
  ON: { text: '开启', tone: 'laser' },
  ERROR: { text: '异常', tone: 'fault' },
  OFFLINE: { text: '离线', tone: 'gray' },
}

export const CAMERA_VIEW: Record<CameraState, StatusView> = {
  OK: { text: '正常', tone: 'ok' },
  ERROR: { text: '异常', tone: 'fault' },
  OFFLINE: { text: '离线', tone: 'gray' },
}

export const PHASE_TEXT: Record<Phase, string> = {
  NO_MODEL: '无模型',
  SCANNING: '扫描中',
  RECONSTRUCTING: '重建中',
  MODEL_READY: '模型就绪',
  PLANNING: '规划中',
  PLAN_READY: '规划就绪',
  EXECUTING: '执行中',
  PAUSED: '已暂停',
  STOPPING: '停止中',
}

export const SERVICE_VIEW: Record<ConnStatus, StatusView> = {
  connected: { text: '已连接', tone: 'ok' },
  connecting: { text: '正在连接…', tone: 'pause' },
  reconnecting: { text: '连接断开，正在重连…', tone: 'fault' },
}

/** 未连接服务（state 为 null）时，机械臂、作业、激光、相机都显示"未知"（需求 5.2）。 */
export function robotView(state: SystemState | null): StatusView {
  const value = state?.robot_state ?? ''
  return isOneOf(ROBOT_STATES, value) ? ROBOT_VIEW[value] : UNKNOWN
}

export function laserView(state: SystemState | null): StatusView {
  const value = state?.laser_state ?? ''
  return isOneOf(LASER_STATES, value) ? LASER_VIEW[value] : UNKNOWN
}

export function cameraView(state: SystemState | null): StatusView {
  const value = state?.camera_state ?? ''
  return isOneOf(CAMERA_STATES, value) ? CAMERA_VIEW[value] : UNKNOWN
}

/** 作业阶段不用胶囊；未知时 known 为 false，用次要文字色显示（前端UI设计 3.2）。 */
export function phaseView(state: SystemState | null): { text: string; known: boolean } {
  const value = state?.phase ?? ''
  return isOneOf(PHASES, value)
    ? { text: PHASE_TEXT[value], known: true }
    : { text: UNKNOWN_TEXT, known: false }
}

export interface AlarmSummary {
  count: number
  text: string
  /** 最高级别：警告为黄（pause），错误为红（fault）；无告警为中性。 */
  tone: 'none' | 'pause' | 'fault'
}

/** Status Bar 的告警按钮（需求 9.2）。不认识的级别按错误处理，宁可醒目。 */
export function alarmSummary(levels: readonly string[]): AlarmSummary {
  if (levels.length === 0) return { count: 0, text: '无告警', tone: 'none' }
  const tone = levels.every((level) => level === 'WARNING') ? 'pause' : 'fault'
  return { count: levels.length, text: `${levels.length} 个告警`, tone }
}

/** 服务端耗时阶段的进行中文字（需求 5.5）。 */
export const PROGRESS_TEXT: Partial<Record<Phase, string>> = {
  SCANNING: '正在扫描…',
  RECONSTRUCTING: '正在重建…',
  PLANNING: '正在规划…',
}

/** 进度百分比：服务端不提供进度（-1）或不在耗时阶段时为 null。 */
export function progressPercent(state: SystemState | null): number | null {
  if (!state || !(state.phase in PROGRESS_TEXT) || state.progress < 0) return null
  return Math.min(100, Math.round(state.progress))
}

/** 需求 6.3 的场景内容表。 */
export interface SceneContent {
  /** 工件：不显示、淡化（扫描、重建期间的旧模型）、正常、可点选。 */
  workpiece: 'none' | 'faded' | 'normal' | 'selectable'
  /** TCP 路径：不显示、静态显示、按动画进度着色、按执行进度着色。 */
  path: 'none' | 'static' | 'animation' | 'execution'
  /** 只在轨迹动画中显示机械臂。 */
  robot: boolean
  /** 三维区中央：暂无模型的提示、服务端耗时阶段的进度。 */
  center: 'empty' | 'progress' | null
}

const PHASE_SCENE: Record<Phase, Omit<SceneContent, 'robot'>> = {
  NO_MODEL: { workpiece: 'none', path: 'none', center: 'empty' },
  SCANNING: { workpiece: 'faded', path: 'none', center: 'progress' },
  RECONSTRUCTING: { workpiece: 'faded', path: 'none', center: 'progress' },
  MODEL_READY: { workpiece: 'normal', path: 'none', center: null },
  PLANNING: { workpiece: 'normal', path: 'none', center: 'progress' },
  PLAN_READY: { workpiece: 'normal', path: 'static', center: null },
  EXECUTING: { workpiece: 'normal', path: 'execution', center: null },
  PAUSED: { workpiece: 'normal', path: 'execution', center: null },
  STOPPING: { workpiece: 'normal', path: 'execution', center: null },
}

/**
 * 按阶段和场景模式给出场景内容。断线期间传入最后收到的状态，保留最后的画面（需求 7.4）；
 * 阶段未知时只显示工件。
 */
export function sceneContent(phase: string | null, mode: SceneMode): SceneContent {
  if (mode === 'select')
    return { workpiece: 'selectable', path: 'none', robot: false, center: null }
  if (mode === 'animate')
    return { workpiece: 'normal', path: 'animation', robot: true, center: null }
  const row = phase !== null && isOneOf(PHASES, phase) ? PHASE_SCENE[phase] : null
  return { ...(row ?? { workpiece: 'normal', path: 'none', center: null }), robot: false }
}

export type RobotNoticeKind = 'softwareEstop' | 'deviceEstop' | 'disabled'

export interface RobotNotice {
  kind: RobotNoticeKind
  title: string
  text: string
  /** 是否有"复位急停"按钮（可用性见 availability）。 */
  reset: boolean
}

export const ROBOT_NOTICES: Record<RobotNoticeKind, RobotNotice> = {
  softwareEstop: {
    kind: 'softwareEstop',
    title: '软件急停已触发',
    text: '机械臂已停止。确认现场安全后点击复位。',
    reset: true,
  },
  deviceEstop: {
    kind: 'deviceEstop',
    title: '设备急停已触发',
    text: '解除设备急停后，在示教器上恢复机械臂。',
    reset: false,
  },
  disabled: {
    kind: 'disabled',
    title: '机械臂未启动',
    text: '请在示教器上启动机械臂（上电并松开刹车）。',
    reset: false,
  },
}

/** 机械臂急停或未启动时的提示（需求 5.6）。两种急停同时存在时显示软件急停。 */
export function robotNotice(state: SystemState | null): RobotNotice | null {
  if (state?.robot_state === 'ESTOP') {
    return state.software_estop ? ROBOT_NOTICES.softwareEstop : ROBOT_NOTICES.deviceEstop
  }
  return state?.robot_state === 'DISABLED' ? ROBOT_NOTICES.disabled : null
}
