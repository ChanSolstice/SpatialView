/**
 * 按钮可用性（需求 5.3）、确认对话框（需求 5.4）和"复位急停""上电"的可用性（需求 5.6）。
 * 按钮可用性不存进 store，由 selector 每次调用这里实时计算（架构设计 5.2）。
 * 急停不在这里：它始终可按，只要 WebSocket 打开就发送（规则 1，由指令通道处理）。
 */
import {
  isOneOf,
  LASER_STATES,
  PHASES,
  ROBOT_STATES,
  type Phase,
  type SystemState,
  type WorkpieceType,
} from '../ros/contract.ts'
import { LASER_VIEW, PROGRESS_TEXT, ROBOT_VIEW } from './phase.ts'
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
  /** 按钮栏底部与急停并排的"上电"（需求 5.1、5.6），不受选面模式限制，单独列出。 */
  power: ButtonView
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
  powerOn: '上电',
} as const

/** 机械臂启动中时"上电"的进行中文字（需求 5.6）。 */
export const POWER_ON_PROGRESS = '正在上电…'

/** 规则 6：这些机械臂状态下不能开始扫描、开启激光；开始清洗、继续时列为警告（需求 5.4）。 */
const ROBOT_NOT_READY: ReadonlySet<string> = new Set([
  'FAULT',
  'ESTOP',
  'DISABLED',
  'STARTING',
  'OFFLINE',
])
/** 规则 6：相机、激光器为这些状态时未就绪。 */
const DEVICE_NOT_READY: ReadonlySet<string> = new Set(['ERROR', 'OFFLINE'])
/**
 * 急停引起的中断尚未完成的阶段，不能复位急停、上电（需求 5.6）。
 * 清洗被中断后停在已暂停，可以复位、上电，排除故障后继续。
 */
const INTERRUPTING: ReadonlySet<string> = new Set(['SCANNING', 'EXECUTING', 'STOPPING'])

export function availability(input: AvailabilityInput): Availability {
  const { state, mode } = input
  const phase = state !== null && isOneOf(PHASES, state.phase) ? state.phase : null
  const table = phase !== null ? TABLE[phase] : null
  // 规则 3–5：未连接、有指令在途、接口不匹配时，除急停和关闭激光外全部不可用
  const blocked =
    !input.connected || state === null || !input.interfaceOk || input.inflight !== null
  // 规则 6。开始清洗、继续不因设备状态不可用，由服务端决定是否受理
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
    // 每次都先选择工件类型（需求 5.4）
    confirm: true,
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
      ? on(mainCell, !selecting, !modelLoading, !planLoading)
      : on(mainCell, !selecting)
  const mainBusy = input.inflight === mainAction
  const main: ButtonView = {
    action: mainAction,
    label: LABELS[mainAction],
    enabled: mainEnabled,
    // 开始清洗、继续每次确认：机械臂将运动（需求 5.4）
    confirm: mainAction !== 'pause',
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

  const settled = !blocked && phase !== null && !INTERRUPTING.has(phase)
  const softwareEstop = state?.robot_state === 'ESTOP' && state.software_estop
  const reset: ResetView = {
    visible: softwareEstop,
    enabled: softwareEstop && settled,
    busy: input.inflight === 'resetEstop',
  }

  // 上电：机械臂未启动时可用；启动中显示进行中（需求 5.6）
  const starting = state?.robot_state === 'STARTING'
  const power: ButtonView = {
    action: 'powerOn',
    label: starting ? POWER_ON_PROGRESS : LABELS.powerOn,
    enabled: settled && state?.robot_state === 'DISABLED',
    confirm: true,
    variant: starting ? 'progress' : 'normal',
    busy: input.inflight === 'powerOn' || starting,
  }

  return { buttons: { scan, select, plan, animate, main, stop, laser }, power, reset }
}

/** 操作当前是否可用：发送前的防御检查（架构设计 5.5），以及确认对话框的自动关闭（需求 5.4）。 */
export function isActionAvailable(action: ButtonAction, result: Availability): boolean {
  if (action === 'resetEstop') return result.reset.enabled
  if (action === 'powerOn') return result.power.enabled
  return Object.values(result.buttons).some((button) => button.action === action && button.enabled)
}

/** 需要确认的操作。 */
export type ConfirmAction =
  'scan' | 'plan' | 'start' | 'resume' | 'stop' | 'laserOn' | 'resetEstop' | 'powerOn'

const CONFIRM_ACTIONS: ReadonlySet<string> = new Set<ConfirmAction>([
  'scan',
  'plan',
  'start',
  'resume',
  'stop',
  'laserOn',
  'resetEstop',
  'powerOn',
])

export function isConfirmAction(action: ButtonAction): action is ConfirmAction {
  return CONFIRM_ACTIONS.has(action)
}

/** 开始扫描时选择的工件类型（需求 5.4）。 */
export interface WorkpieceChoice {
  value: WorkpieceType
  name: string
  text: string
}

export const WORKPIECE_CHOICES: readonly WorkpieceChoice[] = [
  { value: 'REVOLVED', name: '旋转体', text: '可以由一个截面绕一根轴旋转 360° 形成的工件' },
  { value: 'GENERAL', name: '通用', text: '其他工件' },
]

export interface Confirmation {
  title: string
  /** 设备异常的警告，逐行列在正文之前（开始清洗、继续，需求 5.4）。 */
  warnings: string[]
  lines: string[]
  /** 确认按钮的文字与操作一致（前端UI设计 4.4）。 */
  confirmLabel: string
  /** 先选择一项才可以确认（开始扫描的工件类型）；为空表示不需要选择。 */
  choices: readonly WorkpieceChoice[]
  /** 确认按钮在对话框出现后多久才可以按，毫秒（上电的第二次确认）。 */
  confirmDelayMs: number
  /** 确认后再弹出第 2 步的确认，而不是发送指令（上电）。 */
  next: boolean
}

/** 上电的第二次确认：确认按钮延迟 1 秒才可以按，防止快速连点两下直接通过（需求 5.4）。 */
export const POWER_ON_CONFIRM_DELAY_MS = 1000

/** 未选择表面时开始规划的对话框标题和确认按钮（需求 5.4）。 */
export const PLAN_ALL_LABEL = '规划全部'

/**
 * 开始清洗、继续时设备异常的警告（需求 5.4）。APP 不因设备状态禁用这两个操作，改为在确认对话框中列出。
 * 继续时激光器未就绪的，服务端对正常任务拒绝，对整次不出光的任务照常继续（接口文档 6.5）。
 */
export function startWarnings(
  state: SystemState | null,
  action: 'start' | 'resume' = 'start',
): string[] {
  if (state === null) return []
  const warnings: string[] = []
  const robot = state.robot_state
  if (ROBOT_NOT_READY.has(robot) && isOneOf(ROBOT_STATES, robot)) {
    const consequence = action === 'start' ? '服务端可能拒绝开始清洗。' : '服务端可能拒绝继续。'
    warnings.push(`机械臂未就绪（${ROBOT_VIEW[robot].text}），${consequence}`)
  }
  const laser = state.laser_state
  if (DEVICE_NOT_READY.has(laser) && isOneOf(LASER_STATES, laser)) {
    const consequence = action === 'start' ? '本次清洗不出光，只运行轨迹。' : '服务端可能拒绝继续。'
    warnings.push(`激光器未就绪（${LASER_VIEW[laser].text}），${consequence}`)
  }
  return warnings
}

/** 需求 5.4 的确认对话框。step 为 2 时是上电的第二次确认。 */
export function confirmation(
  action: ConfirmAction,
  state: SystemState | null,
  selectionSize: number,
  step: 1 | 2 = 1,
): Confirmation {
  const label = LABELS[action]
  const simple = (lines: string[], title: string = label): Confirmation => ({
    title,
    warnings: [],
    lines,
    confirmLabel: label,
    choices: [],
    confirmDelayMs: 0,
    next: false,
  })
  switch (action) {
    case 'scan':
      return {
        ...simple(
          state !== null && state.model_id !== ''
            ? ['扫描完成后将替换当前模型，并清除当前规划。']
            : [],
          '选择工件类型',
        ),
        choices: WORKPIECE_CHOICES,
      }
    case 'plan': {
      const lines: string[] = []
      if (selectionSize === 0) lines.push('当前未选择表面，将对全部可处理表面进行路径规划。')
      if (state !== null && state.plan_id !== '') lines.push('规划完成后将替换当前规划。')
      lines.push('是否继续？')
      // 未选择表面时发送空数组，即规划全部（接口 6.4）。标题和确认按钮写明，避免误以为没有选面就开始了规划
      if (selectionSize === 0) {
        return { ...simple(lines, PLAN_ALL_LABEL), confirmLabel: PLAN_ALL_LABEL }
      }
      return simple(lines)
    }
    case 'start':
      return {
        ...simple(['机械臂将开始运动，请确认作业区域内无人。是否开始清洗？']),
        warnings: startWarnings(state),
      }
    case 'resume':
      return {
        ...simple(['机械臂将从暂停处继续清洗，不在该处时先移回。请确认作业区域内无人。是否继续？']),
        warnings: startWarnings(state, 'resume'),
      }
    case 'stop':
      return simple(['确认停止当前任务？'])
    case 'laserOn':
      return simple(['确认开启激光？'])
    case 'resetEstop':
      return simple([
        '复位后机械臂可以重新接受运动指令，但不会自动运动。请确认现场安全、作业区域内无人。是否复位？',
      ])
    case 'powerOn':
      return step === 1
        ? {
            ...simple(['机械臂将上电并松开刹车。请确认机械臂周围无人、无障碍物。是否上电？']),
            next: true,
          }
        : {
            ...simple(['请再次确认机械臂周围无人。确认后立即上电。'], '再次确认上电'),
            confirmLabel: '确认上电',
            confirmDelayMs: POWER_ON_CONFIRM_DELAY_MS,
          }
  }
}
