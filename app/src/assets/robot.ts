/**
 * 机械臂模型（需求 3.3、6.6；接口文档第 12 节；架构设计 5.6）：APP 启动时用 urdf-loader 加载一次随 APP 打包的
 * URDF 和网格，修正官方 DAE 的材质，模型常驻内存，只在轨迹动画中挂到场景上。
 */
import {
  Color,
  LoadingManager,
  Mesh,
  MeshStandardMaterial,
  type Material,
  type Object3D,
} from 'three'
import URDFLoader, { type URDFRobot } from 'urdf-loader'
import type { AppStore } from '../store/store.ts'

export class RobotError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RobotError'
  }
}

/** 统一的中性色（前端UI设计第 5 节）：不保留官方的橙色，避免与选中表面、激光开启的橙色混淆。 */
export const ROBOT_MATERIALS = {
  /** 官方网格中的橙色外壳 */
  shell: new MeshStandardMaterial({ color: 0xe9ecf0, roughness: 0.42, metalness: 0.1 }),
  /** 灰色部件（关节端盖、底座、法兰）和末端工具 */
  parts: new MeshStandardMaterial({ color: 0x48505a, roughness: 0.5, metalness: 0.3 }),
}

/** 官方网格只有灰色和橙色两类材质：颜色有明显饱和度的是橙色外壳。 */
export function isShellColor(color: Color): boolean {
  return Math.max(color.r, color.g, color.b) - Math.min(color.r, color.g, color.b) > 0.2
}

/**
 * 全部材质换成不透明的中性色并释放原来的材质。官方 DAE 的材质只写了值为 0 的 transparency，
 * ColladaLoader 会解析为完全透明（架构设计 5.6）。
 */
export function neutralizeMaterials(root: Object3D): void {
  const replaced = new Set<Material>()
  const neutral = (material: Material): Material => {
    replaced.add(material)
    const color = (material as Material & { color?: Color }).color
    return color && isShellColor(color) ? ROBOT_MATERIALS.shell : ROBOT_MATERIALS.parts
  }
  root.traverse((object) => {
    if (!(object instanceof Mesh)) return
    const material = object.material as Material | Material[]
    object.material = Array.isArray(material) ? material.map(neutral) : neutral(material)
  })
  for (const material of replaced) material.dispose()
}

export interface JointMatch {
  /** 规划文件中每个关节对应的 URDF 关节名；不匹配时为空 */
  joints: string[]
  /** 按 joint_name_map 换名后，URDF 中仍然没有的关节（规划文件中的原名） */
  missing: string[]
}

/**
 * 规划文件的关节名对应到 URDF 的可动关节（需求 6.6；接口文档 11.2）：先按 joint_name_map 换名。
 * URDF 中有、文件中没有的关节在动画中保持为 0，不算不匹配。
 */
export function matchJoints(
  planJoints: readonly string[],
  robotJoints: readonly string[],
  nameMap: Readonly<Record<string, string>>,
): JointMatch {
  const available = new Set(robotJoints)
  const joints = planJoints.map((name) => nameMap[name] ?? name)
  const missing = planJoints.filter((_, i) => !available.has(joints[i] as string))
  return { joints: missing.length === 0 ? joints : [], missing }
}

export interface LoadedRobot {
  root: URDFRobot
  /** 可动关节（非固定关节）的名称 */
  joints: string[]
  match(planJoints: readonly string[]): JointMatch
  /** 设置关节值，joints 为 match 得到的 URDF 关节名，values 与之一一对应 */
  pose(joints: readonly string[], values: ArrayLike<number>): void
  dispose(): void
}

export function wrapRobot(root: URDFRobot, nameMap: Readonly<Record<string, string>>): LoadedRobot {
  const movable = Object.entries(root.joints).filter(([, joint]) => joint.jointType !== 'fixed')
  // 动画按规划文件原样显示，不用 URDF 的关节限位改动角度
  for (const [, joint] of movable) joint.ignoreLimits = true
  const joints = movable.map(([name]) => name)
  return {
    root,
    joints,
    match: (planJoints) => matchJoints(planJoints, joints, nameMap),
    pose: (names, values) => {
      names.forEach((name, i) => root.joints[name]?.setJointValue(values[i] as number))
    },
    dispose: () => {
      root.traverse((object) => {
        if (object instanceof Mesh) object.geometry.dispose()
      })
    },
  }
}

/** 加载 URDF 和全部网格；网格都加载完成后才返回，任何一个网格加载失败都视为失败。 */
export function loadRobot(
  urdfUrl: string,
  packages: Readonly<Record<string, string>>,
): Promise<URDFRobot> {
  return new Promise((resolve, reject) => {
    const manager = new LoadingManager()
    const failed: string[] = []
    let robot: URDFRobot | null = null
    manager.onError = (url) => failed.push(url)
    // URDF 解析时网格的加载已经开始，onLoad 在 URDF 和全部网格都结束后触发
    manager.onLoad = () => {
      if (failed.length > 0) reject(new RobotError(`机械臂网格加载失败：${failed.join('，')}`))
      else if (robot) resolve(robot)
    }
    const loader = new URDFLoader(manager)
    loader.packages = { ...packages }
    loader.load(
      urdfUrl,
      (result) => {
        robot = result
      },
      undefined,
      (error: unknown) =>
        reject(
          new RobotError(
            `机械臂模型加载失败：${error instanceof Error ? error.message : String(error)}`,
          ),
        ),
    )
  })
}

export type LoadRobotModel = () => Promise<URDFRobot>

export interface RobotConfig {
  urdf: string
  packages: Readonly<Record<string, string>>
  joint_name_map: Readonly<Record<string, string>>
}

/** URDF 和 package:// 映射的完整路径：配置中的路径相对于 APP 资源的根路径 base（需求 10.2）。 */
export function robotUrls(
  robot: RobotConfig,
  base: string,
): { urdf: string; packages: Record<string, string> } {
  return {
    urdf: `${base}${robot.urdf}`,
    packages: Object.fromEntries(
      Object.entries(robot.packages).map(([name, path]) => [name, `${base}${path}`]),
    ),
  }
}

/** 启动时加载机械臂（随 APP 打包，与服务端状态无关）。 */
export function installRobotLoader(
  store: AppStore,
  robot: RobotConfig,
  base: string,
  load: LoadRobotModel = () => {
    const urls = robotUrls(robot, base)
    return loadRobot(urls.urdf, urls.packages)
  },
): () => void {
  let active = true
  store.getState().setRobot({ id: robot.urdf, status: 'loading', error: null })
  load().then(
    (root) => {
      neutralizeMaterials(root)
      const loaded = wrapRobot(root, robot.joint_name_map)
      if (active) store.getState().setRobot({ status: 'ready', data: loaded })
      else loaded.dispose()
    },
    (error: unknown) => {
      if (!active) return
      const message =
        error instanceof RobotError
          ? error.message
          : `机械臂模型加载失败：${error instanceof Error ? error.message : String(error)}`
      store.getState().setRobot({ status: 'error', error: message })
    },
  )
  return () => {
    active = false
  }
}
