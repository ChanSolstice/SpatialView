/** 测试用的服务端状态。不进入打包产物。 */
import type { OperationResult, Phase, SystemState } from '../ros/contract.ts'

export const EMPTY_RESULT: OperationResult = {
  id: '',
  operation: '',
  result: '',
  code: '',
  detail: '',
  stamp: { sec: 0, nanosec: 0 },
}

export function makeState(overrides: Partial<SystemState> = {}): SystemState {
  return {
    interface_version: '1.0',
    session_id: 'session-a',
    seq: 1,
    stamp: { sec: 1_760_000_000, nanosec: 0 },
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
    last_result: EMPTY_RESULT,
    ...overrides,
  }
}

const MODEL = {
  model_id: 'model_20261015T080000',
  model_url: '/models/model_20261015T080000.glb',
}
const PLAN = {
  plan_id: 'plan_20261015T081000',
  plan_url: '/plans/plan_20261015T081000.json',
  plan_surface_ids: ['s1', 's2'],
}

/** stateForPhase 中模型和规划的 ID。 */
export const STATE_IDS = { model: MODEL.model_id, plan: PLAN.plan_id }

/** 与阶段相符的状态：模型和规划按阶段给出，机械臂在运动阶段为运行中、暂停阶段为暂停。 */
export function stateForPhase(phase: Phase, overrides: Partial<SystemState> = {}): SystemState {
  const hasModel = phase !== 'NO_MODEL'
  const hasPlan = ['PLAN_READY', 'EXECUTING', 'PAUSED', 'STOPPING'].includes(phase)
  const robot =
    phase === 'SCANNING' || phase === 'EXECUTING' || phase === 'STOPPING'
      ? 'RUNNING'
      : phase === 'PAUSED'
        ? 'PAUSED'
        : 'READY'
  return makeState({
    phase,
    robot_state: robot,
    ...(hasModel ? MODEL : {}),
    ...(hasPlan ? PLAN : {}),
    ...overrides,
  })
}
