/** 测试用：不加载网格的最小机械臂，结构与 urdf-loader 的 URDFRobot 相同的部分。不进入打包产物。 */
import { Group, Object3D } from 'three'
import type { URDFJoint, URDFRobot } from 'urdf-loader'
import { I5H_JOINTS } from './plan.ts'

function joint(type: URDFJoint['jointType']): URDFJoint {
  const object = new Object3D() as Object3D & Partial<URDFJoint>
  Object.assign(object, {
    isURDFJoint: true,
    jointType: type,
    ignoreLimits: false,
    jointValue: [0],
    setJointValue(this: { jointValue: number[] }, value: number | null) {
      if (value !== null) this.jointValue = [value]
      return true
    },
  })
  return object as URDFJoint
}

/** 六个转动关节（默认为 i5H 的关节名）加一个固定关节。 */
export function testRobotModel(joints: readonly string[] = I5H_JOINTS): URDFRobot {
  const root = new Group() as Group & Partial<URDFRobot>
  const map: Record<string, URDFJoint> = {}
  for (const name of joints) map[name] = joint('revolute')
  map.tool_joint = joint('fixed')
  for (const child of Object.values(map)) root.add(child)
  Object.assign(root, { isURDFRobot: true, joints: map, links: {} })
  return root as URDFRobot
}
