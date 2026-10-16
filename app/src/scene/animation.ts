/** 轨迹动画的姿态和视角（需求 6.6；架构设计 5.7）。 */
import { Box3, Sphere, Vector3 } from 'three'
import type { LoadedModel } from '../assets/model.ts'
import { interpolateJoints } from '../domain/interpolation.ts'
import type { AnimationData } from '../store/selectors.ts'

/** 按时间 t 插值关节角并设置到机械臂上。values 为关节数长度的暂存数组。 */
export function poseAt(data: AnimationData, t: number, values: Float64Array): void {
  const { jointTimes, jointPositions } = data.plan.data
  interpolateJoints(jointTimes, jointPositions, data.joints.length, t, values)
  data.robot.pose(data.joints, values)
}

const SWEEP_SAMPLES = 32
const sweeps = new WeakMap<AnimationData, Box3>()

/** 机械臂在整段轨迹中扫过的范围：在机械臂的副本上按时间取样，不改变显示中的姿态。 */
export function robotSweep(data: AnimationData): Box3 {
  const cached = sweeps.get(data)
  if (cached) return cached
  const copy = data.robot.root.clone()
  const { duration, jointTimes, jointPositions } = data.plan.data
  const values = new Float64Array(data.joints.length)
  const box = new Box3()
  for (let k = 0; k <= SWEEP_SAMPLES; k++) {
    interpolateJoints(
      jointTimes,
      jointPositions,
      values.length,
      (duration * k) / SWEEP_SAMPLES,
      values,
    )
    data.joints.forEach((name, i) => copy.joints[name]?.setJointValue(values[i] as number))
    copy.updateMatrixWorld(true)
    box.expandByObject(copy)
  }
  sweeps.set(data, box)
  return box
}

/** 轨迹动画的观察范围：工件、路径和机械臂扫过的范围都在其中（需求 6.6）。 */
export function animationSphere(data: AnimationData, model: LoadedModel | null): Sphere {
  const box = robotSweep(data).clone()
  box.union(new Box3(new Vector3(...data.plan.data.min), new Vector3(...data.plan.data.max)))
  if (model) box.union(model.box)
  return box.getBoundingSphere(new Sphere())
}
