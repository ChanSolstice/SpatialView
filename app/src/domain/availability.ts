/**
 * 按钮可用性（需求 5.3）、确认对话框（需求 5.4）和"复位急停"的可用性（需求 5.6）。
 * 按钮可用性不存进 store，由 selector 每次调用这里实时计算（架构设计 5.2）。
 * 急停不在这里：它始终可按，只要 WebSocket 打开就发送（规则 1，由指令通道处理）。
 */
import { isOneOf, PHASES, type Phase, type SystemState } from '../ros/contract.ts'
import { PROGRESS_TEXT } from './phase.ts'
import type { AssetStatus, CommandKey, SceneMode } from './types.ts'

export type PanelButton = 'scan' | 'select' | 'plan' | 'animate' | 'main' | 'stop' | 'laser'

/** 按下按钮时执行的操作：发送指令，或进入本地的场景模式。 */
export type ButtonAction = CommandKey | 'laserOff' | 'enterSelect' | 'enterAnimate'

/** 外观（前端UI设计 4.2）：普通、主操作、当前模式、警示、服务端耗时阶段进行中。 */
export type ButtonVariant = 'normal' | 'primary' | 'active' | 'warn' | 'progress'

export interface ButtonView {
  action: ButtonAction
  label: string
  enabled: boolean
  /** 按下后先弹出确认对话框（需求 5.4）。 */
  confirm: boolean
  variant: ButtonVariant
  /** 图标换成转圈：该按钮的指令在途，或服务端耗时阶段进行中（需求 5.5）。 */
  busy: boolean
}

export interface ResetView {
  /** 软件急停尚未复位时，机械臂提示中显示"复位急停"（需求 5.6）。 */
  visible: boolean
  enabled: boolean
  busy: boolean
}

export interface Availability {
  buttons: Record<PanelButton, ButtonView>
  reset: ResetView
}

export interface AvailabilityInput {
  /** 已连接服务（架构设计 5.3 的 connected）。 */
  connected: boolean
  /** 已连接时最近一次通过校验的服务端状态；未连接，或还没有收到有效状态时为 null。 */
  state: SystemState | null
  /** 接口版本、消息结构和枚举取值都与 APP 一致（需求 7.7；架构设计 4.2）。 */
  interfaceOk: boolean
  inflight: CommandKey | null
  /** 有关闭激光的调用尚未回复。只用于显示转圈，不加锁。 */
  laserOffPending: boolean
  mode: SceneMode
  /** 选择集合中的表面数，用于开始规划的确认（需求 5.4）。 */
  selectionSize: number
  model: AssetStatus
  plan: AssetStatus
  /** 轨迹动画所需的数据已就绪：规划已加载，关节名与机械臂模型一致（需求 6.6）。 */
  animationReady: boolean
}

/**
 * 需求 5.3 的表格：已连接、设备都就绪、无指令在途、不在选面模式时各阶段的按钮。
 * on 可用，off 不可用，progress 显示进行中文字；main 为主按钮的操作和是否可用；laser 指开启激光。
 */
type Cell = 'on' | 'off' | 'progress'
interface Row {
  scan: Cell
  select: Cell
  plan: Cell
  animate: Cell
  main: readonly ['start' | 'pause' | 'resume', Cell]
  stop: Cell
  laser: Cell
}

const TABLE: Record<Phase, Row> = {
  NO_MODEL: row('on', 'off', 'off', 'off', ['start', 'off'], 'off', 'on'),
  SCANNING: row('progress', 'off', 'off', 'off', ['start', 'off'], 'off', 'off'),
  RECONSTRUCTING: row('progress', 'off', 'off', 'off', ['start', 'off'], 'off', 'off'),
  MODEL_READY: row('on', 'on', 'on', 'off', ['start', 'off'], 'off', 'on'),
  PLANNING: row('off', 'off', 'progress', 'off', ['start', 'off'], 'off', 'off'),
  PLAN_READY: row('on', 'on', 'on', 'on', ['start', 'on'], 'off', 'on'),
  EXECUTING: row('off', 'off', 'off', 'off', ['pause', 'on'], 'on', 'off'),
  PAUSED: row('off', 'off', 'off', 'off', ['resume', 'on'], 'on', 'off'),
  STOPPING: row('off', 'off', 'off', 'off', ['start', 'off'], 'off', 'off'),
}

function row(
  scan: Cell,
  select: Cell,
  plan: Cell,
  animate: Cell,
  main: Row['main'],
  stop: Cell,
  laser: Cell,
): Row {
  return { scan, select, plan, animate, main, stop, laser }
}

export const LABELS = {
  scan: '开始扫描',
  select: '选面',
  plan: '开始规划',
  animate: '轨迹动画',
  start: '开始清洗',
  pause: '暂停',
  resume: '继续',
  stop: '停止',
  laserOn: '开启激光',
  laserOff: '关闭激光',
  resetEstop: '复位急停',
} as const

/** 规则 6：这些机械臂状态下不能开始扫描、开始清洗、继续、开启激光。 */
const ROBOT_NOT_READY: ReadonlySet<string> = new Set(['FAULT', 'ESTOP', 'DISABLED', 'OFFLINE'])
/** 规则 6：相机、激光器为这些状态时未就绪。 */
const DEVICE_NOT_READY: ReadonlySet<string> = new Set(['ERROR', 'OFFLINE'])
/** 急停引起的中断尚未完成的阶段，不能复位急停（需求 5.6）。 */
const INTERRUPTING: ReadonlySet<string> = new Set(['SCANNING', 'EXECUTING', 'PAUSED', 'STOPPING'])

export function availability(input: AvailabilityInput): Availability {
  const { state, mode } = input
  const phase = state !== null && isOneOf(PHASES, state.phase) ? state.phase : null
  const table = phase !== null ? TABLE[phase] : null
  // 规则 3–5：未连接、有指令在途、接口不匹配时，除急停和关闭激光外全部不可用
  const blocked =
    !input.connected || state === null || !input.interfaceOk || input.inflight !== null
  // 规则 6
  const robotReady = state !== null && !ROBOT_NOT_READY.has(state.robot_state)
  const cameraReady = state !== null && !DEVICE_NOT_READY.has(state.camera_state)
  const laserReady = state !== null && !DEVICE_NOT_READY.has(state.laser_state)
  // 规则 7：选面模式中只有开始规划可用
  const selecting = mode === 'select'
  // 规则 8：依赖模型的是选面、开始规划、轨迹动画、开始清洗；依赖规划的是轨迹动画、开始清洗
  const modelLoading = input.model === 'loading'
  const planLoading = input.plan === 'loading'

  const on = (cell: Cell | undefined, ...conditions: boolean[]) =>
    !blocked && cell === 'on' && conditions.every(Boolean)
  const progressText = phase !== null ? PROGRESS_TEXT[phase] : undefined

  const scanProgress = table?.scan === 'progress'
  const scan: ButtonView = {
    action: 'scan',
    label: scanProgress ? (progressText ?? LABELS.scan) : LABELS.scan,
    enabled: on(table?.scan, robotReady, cameraReady, !selecting),
    confirm: state !== null && state.model_id !== '',
    variant: scanProgress ? 'progress' : 'normal',
    busy: input.inflight === 'scan' || scanProgress,
  }

  const select: ButtonView = {
    action: 'enterSelect',
    label: LABELS.select,
    enabled: on(table?.select, !selecting, !modelLoading),
    confirm: false,
    variant: selecting ? 'active' : 'normal',
    busy: false,
  }

  const planProgress = table?.plan === 'progress'
  const plan: ButtonView = {
    action: 'plan',
    label: planProgress ? (progressText ?? LABELS.plan) : LABELS.plan,
    enabled: on(table?.plan, !modelLoading),
    confirm: input.selectionSize === 0 || (state !== null && state.plan_id !== ''),
    variant: planProgress ? 'progress' : 'normal',
    busy: input.inflight === 'plan' || planProgress,
  }

  const animating = mode === 'animate'
  const animate: ButtonView = {
    action: 'enterAnimate',
    label: LABELS.animate,
    enabled: on(
      table?.animate,
      !selecting,
      !animating,
      !modelLoading,
      !planLoading,
      input.animationReady,
    ),
    confirm: false,
    variant: animating ? 'active' : 'normal',
    busy: false,
  }

  const [mainAction, mainCell] = table?.main ?? (['start', 'off'] as const)
  const mainEnabled =
    mainAction === 'start'
      ? on(mainCell, robotReady, laserReady, !selecting, !modelLoading, !planLoading)
      : mainAction === 'resume'
        ? on(mainCell, robotReady, laserReady, !selecting)
        : on(mainCell, !selecting)
  const mainBusy = input.inflight === mainAction
  const main: ButtonView = {
    action: mainAction,
    label: LABELS[mainAction],
    enabled: mainEnabled,
    confirm: mainAction === 'start',
    variant: mainEnabled || mainBusy ? 'primary' : 'normal',
    busy: mainBusy,
  }

  const stop: ButtonView = {
    action: 'stop',
    label: LABELS.stop,
    enabled: on(table?.stop, !selecting),
    confirm: true,
    variant: 'normal',
    busy: input.inflight === 'stop',
  }

  // 规则 2：激光不处于关闭状态（包括状态未知）时，只要已连接，"关闭激光"始终可用
  const laserOff = input.connected && state?.laser_state !== 'OFF'
  const laser: ButtonView = laserOff
    ? {
        action: 'laserOff',
        label: LABELS.laserOff,
        enabled: true,
        confirm: false,
        variant: 'warn',
        busy: input.laserOffPending,
      }
    : {
        action: 'laserOn',
        label: LABELS.laserOn,
        enabled: on(table?.laser, robotReady, laserReady, !selecting),
        confirm: true,
        variant: 'normal',
        busy: input.inflight === 'laserOn',
      }

  const softwareEstop = state?.robot_state === 'ESTOP' && state.software_estop
  const reset: ResetView = {
    visible: softwareEstop,
    enabled: softwareEstop && !blocked && phase !== null && !INTERRUPTING.has(phase),
    busy: input.inflight === 'resetEstop',
  }

  return { buttons: { scan, select, plan, animate, main, stop, laser }, reset }
}

/** 操作当前是否可用：发送前的防御检查（架构设计 5.5），以及确认对话框的自动关闭（需求 5.4）。 */
export function isActionAvailable(action: ButtonAction, result: Availability): boolean {
  if (action === 'resetEstop') return result.reset.enabled
  return Object.values(result.buttons).some((button) => button.action === action && button.enabled)
}

/** 需要确认的操作。 */
export type ConfirmAction = 'scan' | 'plan' | 'start' | 'stop' | 'laserOn' | 'resetEstop'

export interface Confirmation {
  title: string
  lines: string[]
  /** 确认按钮的文字与操作一致（前端UI设计 4.4）。 */
  confirmLabel: string
}

/** 需求 5.4 的确认对话框文案。 */
export function confirmation(
  action: ConfirmAction,
  state: SystemState | null,
  selectionSize: number,
): Confirmation {
  const label = LABELS[action]
  switch (action) {
    case 'scan':
      return {
        title: label,
        lines: ['扫描完成后将替换当前模型，并清除当前规划。是否继续？'],
        confirmLabel: label,
      }
    case 'plan': {
      const lines: string[] = []
      if (selectionSize === 0) lines.push('当前未选择表面，将对全部可处理表面进行路径规划。')
      if (state !== null && state.plan_id !== '') lines.push('规划完成后将替换当前规划。')
      lines.push('是否继续？')
      return { title: label, lines, confirmLabel: label }
    }
    case 'start':
      return {
        title: label,
        lines: ['机械臂将开始运动，请确认作业区域内无人。是否开始清洗？'],
        confirmLabel: label,
      }
    case 'stop':
      return { title: label, lines: ['确认停止当前任务？'], confirmLabel: label }
    case 'laserOn':
      return { title: label, lines: ['确认开启激光？'], confirmLabel: label }
    case 'resetEstop':
      return {
        title: label,
        lines: [
          '复位后机械臂可以重新接受运动指令，但不会自动运动。请确认现场安全、作业区域内无人。是否复位？',
        ],
        confirmLabel: label,
      }
  }
}
