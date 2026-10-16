import {
  BufferGeometry,
  Color,
  Group,
  Mesh,
  MeshPhongMaterial,
  MeshStandardMaterial,
  type Material,
} from 'three'
import { describe, expect, it } from 'vitest'
import { createAppStore } from '../store/store.ts'
import { I5H_JOINTS } from '../testing/plan.ts'
import { testRobotModel } from '../testing/robot.ts'
import {
  installRobotLoader,
  isShellColor,
  matchJoints,
  neutralizeMaterials,
  ROBOT_MATERIALS,
  RobotError,
  robotUrls,
  wrapRobot,
} from './robot.ts'

describe('材质修正（前端UI设计第 5 节）', () => {
  // 官方 DAE 中的颜色（linkN.DAE 的 diffuse）
  const grey = [0.411765, 0.309804, 0.792157].map((v) => new Color(v, v, v))
  const orange = new Color(0.909804, 0.513726, 0)

  it('橙色外壳与灰色部件', () => {
    expect(isShellColor(orange)).toBe(true)
    for (const color of grey) expect(isShellColor(color)).toBe(false)
  })

  it('全部换成共享的中性色，原来的材质释放；多材质的网格逐个替换', () => {
    const transparent = (color: Color) =>
      new MeshPhongMaterial({ color, transparent: true, opacity: 0 })
    const single = new Mesh(new BufferGeometry(), transparent(orange))
    const multi = new Mesh(new BufferGeometry(), [transparent(grey[0]!), transparent(orange)])
    const tool = new Mesh(new BufferGeometry(), new MeshStandardMaterial({ color: 0x48505a }))
    const root = new Group().add(single, multi, tool)
    const originals = [single.material, ...(multi.material as Material[]), tool.material]
    const disposed: Material[] = []
    for (const m of originals as Material[]) m.addEventListener('dispose', () => disposed.push(m))

    neutralizeMaterials(root)
    expect(single.material).toBe(ROBOT_MATERIALS.shell)
    expect(multi.material).toEqual([ROBOT_MATERIALS.parts, ROBOT_MATERIALS.shell])
    expect(tool.material).toBe(ROBOT_MATERIALS.parts)
    expect(disposed).toHaveLength(4)
    expect(ROBOT_MATERIALS.shell.transparent).toBe(false)
    expect(ROBOT_MATERIALS.shell.opacity).toBe(1)
  })
})

describe('matchJoints（需求 6.6；接口文档 11.2）', () => {
  it('名称一致', () => {
    expect(matchJoints(['a', 'b'], ['a', 'b', 'c'], {})).toEqual({
      joints: ['a', 'b'],
      missing: [],
    })
  })

  it('URDF 中有、文件中没有的关节不算不匹配', () => {
    expect(matchJoints(['b'], ['a', 'b'], {}).missing).toEqual([])
  })

  it('按 joint_name_map 换名', () => {
    expect(matchJoints(['J1', 'b'], ['a', 'b'], { J1: 'a' })).toEqual({
      joints: ['a', 'b'],
      missing: [],
    })
  })

  it('文件中的关节在 URDF 中没有：列出原名，不给出对应', () => {
    expect(matchJoints(['a', 'X', 'Y'], ['a'], { Y: 'Z' })).toEqual({
      joints: [],
      missing: ['X', 'Y'],
    })
  })
})

describe('wrapRobot', () => {
  it('可动关节不含固定关节，关闭限位；按关节名设置关节值', () => {
    const root = testRobotModel()
    const robot = wrapRobot(root, {})
    expect(robot.joints).toEqual(I5H_JOINTS)
    expect(root.joints.shoulder_joint?.ignoreLimits).toBe(true)
    robot.pose(['wrist1_joint', 'shoulder_joint'], [0.5, -7])
    expect(root.joints.wrist1_joint?.jointValue).toEqual([0.5])
    expect(root.joints.shoulder_joint?.jointValue).toEqual([-7])
    expect(robot.match(['J1'])).toEqual({ joints: [], missing: ['J1'] })
  })
})

describe('installRobotLoader', () => {
  const config = { urdf: 'robot/r.urdf', packages: {}, joint_name_map: { J1: 'shoulder_joint' } }
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

  it('加载完成后修正材质，写入 store；关节名映射取自配置', async () => {
    const store = createAppStore()
    installRobotLoader(store, config, '/', () => Promise.resolve(testRobotModel()))
    expect(store.getState().robot).toMatchObject({ id: 'robot/r.urdf', status: 'loading' })
    await flush()
    const robot = store.getState().robot.data
    expect(store.getState().robot.status).toBe('ready')
    expect(robot?.match(['J1']).missing).toEqual([])
  })

  it('加载失败时记录原因', async () => {
    const store = createAppStore()
    installRobotLoader(store, config, '/', () =>
      Promise.reject(new RobotError('机械臂网格加载失败：x')),
    )
    await flush()
    expect(store.getState().robot).toMatchObject({
      status: 'error',
      error: '机械臂网格加载失败：x',
    })
  })

  it('URDF 和 package:// 的路径相对于 APP 资源的根路径', () => {
    expect(
      robotUrls(
        { urdf: 'robot/a.urdf', packages: { pkg: 'robot/pkg' }, joint_name_map: {} },
        '/base/',
      ),
    ).toEqual({ urdf: '/base/robot/a.urdf', packages: { pkg: '/base/robot/pkg' } })
  })
})
