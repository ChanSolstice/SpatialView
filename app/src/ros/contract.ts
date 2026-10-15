/**
 * APP 与服务端的接口约定（服务端对接接口文档第 3–7 节），与 spatialview_msgs 一一对应。
 * tests/contract.test.ts 检查本文件与 .msg、.srv 和接口文档第 7 节一致；修改接口时三处同时修改（架构设计 4.3）。
 */
import { z } from 'zod'

/** APP 期望的接口版本（接口文档第 3 节）。主版本号不一致时，除急停和关闭激光外的指令不可用。 */
export const INTERFACE_VERSION = '1.0'

export const ROBOT_STATES = [
  'READY',
  'RUNNING',
  'PAUSED',
  'FAULT',
  'ESTOP',
  'DISABLED',
  'OFFLINE',
] as const
export const CAMERA_STATES = ['OK', 'ERROR', 'OFFLINE'] as const
export const LASER_STATES = ['OFF', 'ON', 'ERROR', 'OFFLINE'] as const
export const PHASES = [
  'NO_MODEL',
  'SCANNING',
  'RECONSTRUCTING',
  'MODEL_READY',
  'PLANNING',
  'PLAN_READY',
  'EXECUTING',
  'PAUSED',
  'STOPPING',
] as const
export const ALARM_LEVELS = ['WARNING', 'ERROR'] as const
export const OPERATIONS = ['SCAN', 'RECONSTRUCT', 'PLAN', 'TASK'] as const
export const RESULTS = ['SUCCEEDED', 'FAILED', 'INTERRUPTED', 'STOPPED'] as const
export const TASK_COMMANDS = ['START', 'PAUSE', 'RESUME', 'STOP'] as const

export type RobotState = (typeof ROBOT_STATES)[number]
export type CameraState = (typeof CAMERA_STATES)[number]
export type LaserState = (typeof LASER_STATES)[number]
export type Phase = (typeof PHASES)[number]
export type AlarmLevel = (typeof ALARM_LEVELS)[number]
export type Operation = (typeof OPERATIONS)[number]
export type Result = (typeof RESULTS)[number]
export type TaskCommand = (typeof TASK_COMMANDS)[number]

/** 7.1 指令状态码：指令 Service 响应中的 code。 */
export const COMMAND_CODES = [
  'OK',
  'INVALID_ARGUMENT',
  'INVALID_STATE',
  'MODEL_MISMATCH',
  'PLAN_MISMATCH',
  'INVALID_SURFACE',
  'ROBOT_NOT_READY',
  'CAMERA_NOT_READY',
  'LASER_NOT_READY',
  'INTERLOCK',
  'MODULE_UNAVAILABLE',
  'DEVICE_ERROR',
  'INTERNAL_ERROR',
] as const

/** 7.2 操作结果原因码：last_result.code，为空表示没有需要说明的原因。 */
export const RESULT_CODES = [
  'PLAN_PARTIAL',
  'ROBOT_ESTOP',
  'ROBOT_FAULT',
  'ROBOT_PROTECTIVE_STOP',
  'ROBOT_SAFEGUARD_STOP',
  'ROBOT_DISABLED',
  'ROBOT_OFFLINE',
  'CAMERA_ERROR',
  'CAMERA_OFFLINE',
  'LASER_ERROR',
  'LASER_OFFLINE',
  'DEVICE_ERROR',
  'NO_VALID_DATA',
  'RECONSTRUCT_ERROR',
  'NO_SOLUTION',
  'EXPORT_ERROR',
  'TIMEOUT',
  'MODULE_UNAVAILABLE',
  'INTERNAL_ERROR',
] as const

/** 7.3 告警码：alarms[].code。设备专用告警由服务端登记后再加入。 */
export const ALARM_CODES = [
  'ROBOT_FAULT',
  'ROBOT_PROTECTIVE_STOP',
  'ROBOT_SAFEGUARD_STOP',
  'ROBOT_OFFLINE',
  'CAMERA_ERROR',
  'CAMERA_OFFLINE',
  'LASER_ERROR',
  'LASER_OFFLINE',
  'MODULE_UNAVAILABLE',
  'SCAN_FAILED',
  'RECONSTRUCT_FAILED',
  'PLAN_FAILED',
  'LEFTOVER_TASK_STOPPED',
] as const

export type CommandCode = (typeof COMMAND_CODES)[number]
export type ResultCode = (typeof RESULT_CODES)[number]
export type AlarmCode = (typeof ALARM_CODES)[number]

/** 判断字符串是否为某个枚举的取值；不认识的取值由界面显示为"未知"（架构设计 4.2）。 */
export function isOneOf<T extends string>(values: readonly T[], value: string): value is T {
  return (values as readonly string[]).includes(value)
}

/** 主版本号是否与 APP 期望的一致（接口文档第 3 节）。 */
export function isCompatibleVersion(version: string): boolean {
  const major = (v: string) => v.split('.')[0]
  return /^\d+\.\d+$/.test(version) && major(version) === major(INTERFACE_VERSION)
}

export const SYSTEM_STATE_TOPIC = {
  name: '/spatialview/system_state',
  type: 'spatialview_msgs/msg/SystemState',
} as const

export const SERVICES = {
  getSystemState: {
    name: '/spatialview/get_system_state',
    type: 'spatialview_msgs/srv/GetSystemState',
  },
  startScan: { name: '/spatialview/start_scan', type: 'spatialview_msgs/srv/StartScan' },
  startPlan: { name: '/spatialview/start_plan', type: 'spatialview_msgs/srv/StartPlan' },
  taskControl: { name: '/spatialview/task_control', type: 'spatialview_msgs/srv/TaskControl' },
  setLaser: { name: '/spatialview/set_laser', type: 'spatialview_msgs/srv/SetLaser' },
  resetEstop: { name: '/spatialview/reset_estop', type: 'spatialview_msgs/srv/ResetEstop' },
} as const

/** 机械臂驱动的急停 Service（接口文档 6.7）。名称为暂定名，以服务端在接口文档第 16 节填写的为准。 */
export const ESTOP_SERVICE = {
  name: '/robot_driver/emergency_stop',
  type: 'std_srvs/srv/Trigger',
} as const

/*
 * 消息结构的运行时校验（架构设计 4.2）。枚举字段只校验为字符串，不认识的取值不算接口不匹配；
 * 消息中多出的字段被忽略，以兼容次版本号增加的字段。
 */
export const timeSchema = z.object({
  sec: z.number().int(),
  nanosec: z.number().int().nonnegative(),
})

export const alarmSchema = z.object({
  code: z.string(),
  level: z.string(),
  detail: z.string(),
  stamp: timeSchema,
})

export const operationResultSchema = z.object({
  id: z.string(),
  operation: z.string(),
  result: z.string(),
  code: z.string(),
  detail: z.string(),
  stamp: timeSchema,
})

export const systemStateSchema = z.object({
  interface_version: z.string(),
  session_id: z.string(),
  seq: z.number().int().nonnegative(),
  stamp: timeSchema,
  robot_state: z.string(),
  software_estop: z.boolean(),
  camera_state: z.string(),
  laser_state: z.string(),
  phase: z.string(),
  progress: z.number(),
  exec_time: z.number(),
  model_id: z.string(),
  model_url: z.string(),
  plan_id: z.string(),
  plan_url: z.string(),
  plan_surface_ids: z.array(z.string()),
  alarms: z.array(alarmSchema),
  last_result: operationResultSchema,
})

/** 五个指令 Service 的响应（接口文档 6.1）。 */
export const commandResponseSchema = z.object({
  code: z.string(),
  detail: z.string(),
  state: systemStateSchema,
})

export const getSystemStateResponseSchema = z.object({ state: systemStateSchema })

/** std_srvs/srv/Trigger 的响应：机械臂急停 Service。 */
export const triggerResponseSchema = z.object({ success: z.boolean(), message: z.string() })

export type RosTime = z.infer<typeof timeSchema>
export type Alarm = z.infer<typeof alarmSchema>
export type OperationResult = z.infer<typeof operationResultSchema>
export type SystemState = z.infer<typeof systemStateSchema>
export type CommandResponse = z.infer<typeof commandResponseSchema>
export type GetSystemStateResponse = z.infer<typeof getSystemStateResponseSchema>
export type TriggerResponse = z.infer<typeof triggerResponseSchema>

export type EmptyRequest = Record<string, never>
export interface StartPlanRequest {
  model_id: string
  surface_ids: string[]
}
export interface TaskControlRequest {
  command: TaskCommand
  plan_id: string
}
export interface SetLaserRequest {
  on: boolean
}

/** 各 Service 的请求字段，用于与 .srv 对照。 */
export const REQUEST_FIELDS: Record<keyof typeof SERVICES, readonly string[]> = {
  getSystemState: [],
  startScan: [],
  startPlan: ['model_id', 'surface_ids'],
  taskControl: ['command', 'plan_id'],
  setLaser: ['on'],
  resetEstop: [],
}
