/**
 * 工件、表面分界线和 TCP 路径的共享材质（前端UI设计第 5 节；架构设计 5.7）。只建这几个，切换时替换 mesh 的
 * 材质引用，不新建材质；随 APP 常驻，不随模型、规划释放。
 */
import {
  ConeGeometry,
  DoubleSide,
  MeshBasicMaterial,
  MeshStandardMaterial,
  type MeshStandardMaterialParameters,
} from 'three'
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js'

function workpiece(
  color: number,
  extra: MeshStandardMaterialParameters = {},
): MeshStandardMaterial {
  return new MeshStandardMaterial({
    color,
    roughness: 0.62,
    metalness: 0.12,
    // 重建网格的三角面朝向不一致时也能正常显示和点选（接口文档 10.2）
    side: DoubleSide,
    // 贴近表面的路径和分界线不闪烁
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
    ...extra,
  })
}

export const WORKPIECE_MATERIALS = {
  normal: workpiece(0xa9b4c0),
  selected: workpiece(0xf28c28, { roughness: 0.5 }),
  unselectable: workpiece(0x59616b),
  /** 扫描、重建期间淡化显示的旧模型 */
  faded: workpiece(0xa9b4c0, { transparent: true, opacity: 0.32, depthWrite: false }),
}

/** 表面分界线：线宽以屏幕像素计，分辨率由场景按画布尺寸设置。 */
export const BOUNDARY_MATERIAL = new LineMaterial({
  color: 0x39414b,
  linewidth: 1.6,
  transparent: true,
  opacity: 0.75,
})

export const PATH_COLORS = {
  process: 0x1f6feb,
  travel: 0x7f8995,
  progress: 0x1e9e50,
}

/** 工艺段为粗实线，空行程为细虚线（线段 18 毫米、间隔 14 毫米），进度为叠在工艺段上的绿线。 */
export const PATH_MATERIALS = {
  process: new LineMaterial({ color: PATH_COLORS.process, linewidth: 4 }),
  travel: new LineMaterial({
    color: PATH_COLORS.travel,
    linewidth: 1.8,
    dashed: true,
    dashSize: 0.018,
    gapSize: 0.014,
  }),
  // 负的多边形偏移，叠在蓝线之上不闪烁
  progress: new LineMaterial({
    color: PATH_COLORS.progress,
    linewidth: 5,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -8,
  }),
}

/** 线宽以屏幕像素计的材质，画布尺寸变化时由场景更新分辨率。 */
export const SCREEN_LINE_MATERIALS: readonly LineMaterial[] = [
  BOUNDARY_MATERIAL,
  ...Object.values(PATH_MATERIALS),
]

/**
 * 方向箭头：小圆锥，尖端沿 +Y。工艺段的箭头按实例着色，随进度变绿。几何体为间距 ARROW_SPACING 时的大小
 * （半径 9 毫米、长 26 毫米），其他间距按比例缩放，工件较小时调小间距，箭头也随之变小。
 */
export const ARROW_GEOMETRY = new ConeGeometry(0.009, 0.026, 12)
export const ARROW_SPACING = 0.16
export const ARROW_MATERIALS = {
  process: new MeshBasicMaterial({ color: 0xffffff }),
  travel: new MeshBasicMaterial({ color: PATH_COLORS.travel }),
}
