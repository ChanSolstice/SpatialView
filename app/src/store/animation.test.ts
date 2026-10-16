import { describe, expect, it } from 'vitest'
import { buildPath } from '../assets/path.ts'
import { parsePlan } from '../assets/plan.ts'
import { wrapRobot } from '../assets/robot.ts'
import { stateForPhase, STATE_IDS } from '../testing/fixtures.ts'
import { I5H_JOINTS, testPlanJson } from '../testing/plan.ts'
import { testRobotModel } from '../testing/robot.ts'
import { selectAnimationData, selectAvailability, selectJointMismatch } from './selectors.ts'
import { createAppStore } from './store.ts'

const IDS = { planId: STATE_IDS.plan, modelId: STATE_IDS.model }
const plan = (jointNames = I5H_JOINTS) =>
  buildPath(parsePlan(testPlanJson({ ...IDS, jointNames }), IDS, 0.05))

function storeWith(jointNames?: string[], nameMap: Record<string, string> = {}) {
  const store = createAppStore({
    conn: { status: 'connected', socketOpen: true, sessionId: 's', seq: 1 },
    server: stateForPhase('PLAN_READY'),
  })
  store.getState().setModel({ id: STATE_IDS.model, status: 'ready' })
  store.getState().setPlan({ id: STATE_IDS.plan, status: 'ready', data: plan(jointNames) })
  store
    .getState()
    .setRobot({ id: 'r', status: 'ready', data: wrapRobot(testRobotModel(), nameMap) })
  return store
}

describe('轨迹动画的可用性（需求 6.6）', () => {
  it('规划和机械臂都已加载、关节名一致时可用', () => {
    const s = storeWith().getState()
    expect(selectAnimationData(s)?.joints).toEqual(I5H_JOINTS)
    expect(selectJointMismatch(s)).toBeNull()
    expect(selectAvailability(s).buttons.animate.enabled).toBe(true)
  })

  it('机械臂还没有加载、规划还没有加载时不可用，也不算不匹配', () => {
    const store = storeWith()
    store.getState().setRobot({ status: 'loading', data: null })
    expect(selectAvailability(store.getState()).buttons.animate.enabled).toBe(false)
    expect(selectJointMismatch(store.getState())).toBeNull()
    store.getState().setRobot({ status: 'ready', data: wrapRobot(testRobotModel(), {}) })
    store.getState().setPlan({ status: 'loading', data: null })
    expect(selectAvailability(store.getState()).buttons.animate.enabled).toBe(false)
  })

  it('关节名不一致：不可用，给出不匹配的关节（本地告警）', () => {
    const s = storeWith(['J1', ...I5H_JOINTS.slice(1, 5), 'J6']).getState()
    expect(selectAnimationData(s)).toBeNull()
    expect(selectJointMismatch(s)).toBe('J1，J6')
    expect(selectAvailability(s).buttons.animate.enabled).toBe(false)
  })

  it('配置中的关节名映射解决不一致', () => {
    const s = storeWith(['J1', ...I5H_JOINTS.slice(1)], { J1: 'shoulder_joint' }).getState()
    expect(selectAnimationData(s)?.joints[0]).toBe('shoulder_joint')
    expect(selectAvailability(s).buttons.animate.enabled).toBe(true)
  })
})
