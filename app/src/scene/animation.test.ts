// @vitest-environment jsdom
import { Vector3 } from 'three'
import URDFLoader from 'urdf-loader'
import { describe, expect, it } from 'vitest'
import urdf from '../../public/robot/aubo_i5H_dev.urdf?raw'
import { buildPath } from '../assets/path.ts'
import { parsePlan } from '../assets/plan.ts'
import { wrapRobot } from '../assets/robot.ts'
import type { AnimationData } from '../store/selectors.ts'
import { I5H_JOINTS, testPlanJson } from '../testing/plan.ts'
import { animationSphere, poseAt, robotSweep } from './animation.ts'

const IDS = { planId: 'plan_a', modelId: 'model_a' }

function data(): AnimationData {
  const loader = new URDFLoader()
  loader.loadMeshCb = () => {}
  const robot = wrapRobot(loader.parse(urdf), {})
  // 第 j 个关节的角度为 j × t / 100，0–10 秒
  const plan = buildPath(parsePlan(testPlanJson(IDS), IDS, 0.05))
  return { plan, robot, joints: I5H_JOINTS }
}

const tcp = (d: AnimationData) => {
  d.robot.root.updateMatrixWorld(true)
  return d.robot.root.links.tcp_link!.getWorldPosition(new Vector3())
}

describe('poseAt', () => {
  it('按动画时间插值并设置关节角', () => {
    const d = data()
    poseAt(d, 5, new Float64Array(6))
    // 关节值以 Float32Array 存放
    expect(d.robot.root.joints.wrist3_joint?.jointValue[0]).toBeCloseTo(0.25, 6)
    expect(d.robot.root.joints.upperArm_joint?.jointValue[0]).toBeCloseTo(0.05, 6)
  })
})

describe('robotSweep', () => {
  it('在副本上取样，不改变显示中的姿态；同一份数据只计算一次', () => {
    const d = data()
    poseAt(d, 3, new Float64Array(6))
    const before = tcp(d)
    const box = robotSweep(d)
    expect(tcp(d).distanceTo(before)).toBe(0)
    expect(robotSweep(d)).toBe(box)
    // 工具（圆柱）在各个取样姿态下都在范围内
    for (const t of [0, 5, 10]) {
      poseAt(d, t, new Float64Array(6))
      expect(box.containsPoint(tcp(d).multiplyScalar(0.999))).toBe(true)
    }
  })

  it('观察范围包含路径', () => {
    const d = data()
    const sphere = animationSphere(d, null)
    // 路径的端点可能正好在包围盒的角上，也就是包围球的球面上
    for (const point of [d.plan.start, d.plan.end]) {
      expect(point.distanceTo(sphere.center)).toBeLessThanOrEqual(sphere.radius + 1e-9)
    }
  })
})
