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
 * 方向箭头：细长的小圆锥，尖端沿 +Y。大小与线宽一样以屏幕像素计：几何体的单位是像素（底面直径 10、长 16），
 * 场景每次绘制前按相机换算成米（path.ts 的 fitArrows），缩放时在屏幕上的大小不变，放大工件时不会遮住工件。
 * 半透明、不写深度；仍参与深度测试，被工件挡住的不显示。空行程的箭头小一号。
 */
export const ARROW_GEOMETRY = new ConeGeometry(5, 16, 16)
export const TRAVEL_ARROW_SCALE = 0.75

/**
 * 箭头取所在线段颜色的深色，在线上能看出箭头的形状，在浅灰的工件上也看得清：工艺段的箭头为深蓝，
 * 随进度变为深绿（状态色 run、ok 的文字色）；空行程的箭头为深灰（--text-2）。工艺段的箭头按实例着色。
 */
export const ARROW_COLORS = { process: 0x1a56b8, progress: 0x16653a, travel: 0x4d5662 }
export const ARROW_MATERIALS = {
  process: new MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.8,
    depthWrite: false,
  }),
  travel: new MeshBasicMaterial({
    color: ARROW_COLORS.travel,
    transparent: true,
    opacity: 0.8,
    depthWrite: false,
  }),
}
