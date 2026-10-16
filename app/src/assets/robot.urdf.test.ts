// @vitest-environment jsdom
/** 用随 APP 打包的开发用 URDF 检查关节和连杆（接口文档第 12 节）；不加载网格。 */
import { Mesh } from 'three'
import URDFLoader from 'urdf-loader'
import { describe, expect, it } from 'vitest'
import urdf from '../../public/robot/aubo_i5H_dev.urdf?raw'
import { I5H_JOINTS } from '../testing/plan.ts'
import { neutralizeMaterials, ROBOT_MATERIALS, wrapRobot } from './robot.ts'

function parse() {
  const loader = new URDFLoader()
  loader.packages = { aubo_description: '/robot/aubo_description' }
  const meshes: string[] = []
  loader.loadMeshCb = (path) => meshes.push(path)
  return { root: loader.parse(urdf), meshes }
}

describe('开发用 URDF（aubo_i5H_dev.urdf）', () => {
  it('六个转动关节与规划文件的关节名一致，有工具和 TCP 连杆', () => {
    const { root, meshes } = parse()
    const robot = wrapRobot(root, {})
    expect(robot.joints).toEqual(I5H_JOINTS)
    expect(robot.match(I5H_JOINTS).missing).toEqual([])
    expect(Object.keys(root.links)).toEqual(
      expect.arrayContaining(['base_link', 'tool_link', 'tcp_link']),
    )
    expect(meshes).toHaveLength(7)
    expect(meshes[0]).toBe('/robot/aubo_description/meshes/aubo_i5H/visual/link0.DAE')
  })

  it('示意工具（圆柱）换成灰色部件的材质', () => {
    const { root } = parse()
    neutralizeMaterials(root)
    const tool: Mesh[] = []
    root.links.tool_link?.traverse((object) => {
      if (object instanceof Mesh) tool.push(object)
    })
    expect(tool).toHaveLength(1)
    expect(tool[0]?.material).toBe(ROBOT_MATERIALS.parts)
  })

  it('TCP 在法兰 Z 轴 0.15 米处：关节角为 0 时位于法兰正上方', () => {
    const { root } = parse()
    root.updateMatrixWorld(true)
    const flange = root.links.wrist3_Link!.getWorldPosition(root.position.clone())
    const tcp = root.links.tcp_link!.getWorldPosition(root.position.clone())
    expect(tcp.distanceTo(flange)).toBeCloseTo(0.15, 6)
  })
})
