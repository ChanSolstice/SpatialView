/**
 * 状态码到显示文字的对照（接口文档第 7 节的"APP 显示"一列）。面向操作员的文字全部由 APP 给出（需求 5.5）。
 * tests/codes.test.ts 检查每个码都有文字，且与接口文档一致。
 */
import type { AlarmCode, CommandCode, ResultCode } from '../ros/contract.ts'

/** 7.1 指令状态码：指令被拒绝时的提示。OK 不提示。 */
export const COMMAND_CODE_TEXT: Record<CommandCode, string> = {
  OK: '',
  INVALID_ARGUMENT: '指令参数错误',
  INVALID_STATE: '当前状态不允许该操作',
  MODEL_MISMATCH: '模型已更新，请重新选择表面',
  PLAN_MISMATCH: '规划已更新，请重新确认',
  INVALID_SURFACE: '所选表面无效，请重新选择',
  ROBOT_NOT_READY: '机械臂未就绪',
  CAMERA_NOT_READY: '相机未就绪',
  LASER_NOT_READY: '激光器未就绪',
  INTERLOCK: '安全联锁条件不满足，无法开启激光',
  MODULE_UNAVAILABLE: '服务端模块不可用',
  DEVICE_ERROR: '设备未响应或拒绝执行',
  INTERNAL_ERROR: '服务端内部错误',
}

/** 7.2 操作结果原因码：结果提示框中的原因。 */
export const RESULT_CODE_TEXT: Record<ResultCode, string> = {
  PLAN_PARTIAL: '部分表面无法生成清洗路径，未包含在本次规划中',
  ROBOT_ESTOP: '机械臂急停',
  ROBOT_FAULT: '机械臂故障',
  ROBOT_PROTECTIVE_STOP: '机械臂保护性停止',
  ROBOT_SAFEGUARD_STOP: '机械臂防护停止',
  ROBOT_DISABLED: '机械臂已断电或抱闸',
  ROBOT_OFFLINE: '机械臂离线',
  CAMERA_ERROR: '相机异常',
  CAMERA_OFFLINE: '相机离线',
  LASER_ERROR: '激光器异常',
  LASER_OFFLINE: '激光器离线',
  DEVICE_ERROR: '设备执行出错',
  NO_VALID_DATA: '未获得有效的扫描数据',
  RECONSTRUCT_ERROR: '三维重建失败',
  NO_SOLUTION: '所选表面均无法生成清洗路径',
  EXPORT_ERROR: '文件生成失败',
  TIMEOUT: '操作超时',
  MODULE_UNAVAILABLE: '服务端模块不可用',
  INTERNAL_ERROR: '服务端内部错误',
}

/** 7.3 告警码：告警面板中的名称。 */
export const ALARM_CODE_TEXT: Record<AlarmCode, string> = {
  ROBOT_FAULT: '机械臂故障',
  ROBOT_PROTECTIVE_STOP: '机械臂保护性停止，请检查后在示教器上解除',
  ROBOT_SAFEGUARD_STOP: '机械臂防护停止，请检查安全门、光栅等安全装置',
  ROBOT_OFFLINE: '机械臂离线',
  CAMERA_ERROR: '相机异常',
  CAMERA_OFFLINE: '相机离线',
  LASER_ERROR: '激光器异常',
  LASER_OFFLINE: '激光器离线',
  MODULE_UNAVAILABLE: '服务端模块不可用',
  SCAN_FAILED: '扫描失败',
  RECONSTRUCT_FAILED: '重建失败',
  PLAN_FAILED: '规划失败',
  LEFTOVER_TASK_STOPPED: '已停止服务端重启前未完成的任务',
}

/** 未知状态码的通用文字（接口文档 7.4、需求 9.2）。 */
export const UNKNOWN_COMMAND_TEXT = '操作被拒绝'
export const UNKNOWN_RESULT_TEXT = '未知原因'
export const UNKNOWN_ALARM_TEXT = '设备告警'

function lookup<T extends string>(table: Record<T, string>, code: string): string | undefined {
  return Object.hasOwn(table, code) ? table[code as T] : undefined
}

export function commandCodeText(code: string): string {
  return lookup(COMMAND_CODE_TEXT, code) ?? UNKNOWN_COMMAND_TEXT
}

/** 原因码为空表示没有需要说明的原因，返回空字符串。 */
export function resultCodeText(code: string): string {
  if (code === '') return ''
  return lookup(RESULT_CODE_TEXT, code) ?? UNKNOWN_RESULT_TEXT
}

export function alarmCodeText(code: string): string {
  return lookup(ALARM_CODE_TEXT, code) ?? UNKNOWN_ALARM_TEXT
}

/** 状态码是否为接口文档中已知的码（未知的码在提示中附上状态码本身）。 */
export function isKnownCode(code: string): boolean {
  return (
    Object.hasOwn(COMMAND_CODE_TEXT, code) ||
    Object.hasOwn(RESULT_CODE_TEXT, code) ||
    Object.hasOwn(ALARM_CODE_TEXT, code)
  )
}
