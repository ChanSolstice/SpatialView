/**
 * 工件、表面分界线和 TCP 路径的共享材质（前端UI设计第 5 节；架构设计 5.7）。只建这几个，切换时替换 mesh 的
 * 材质引用，不新建材质；随 APP 常驻，不随模型、规划释放。
 */
import {
  BufferAttribute,
  BufferGeometry,
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
  /** 选面模式中当前规划连续扩展进来、当前未选中的表面（需求 6.4）：--expand */
  expanded: workpiece(0x7fb0ee, { roughness: 0.5 }),
  /** 选面模式中鼠标指向的表面：未选中为浅橙色，已选中为深橙色，表示点击后会选中或取消 */
  hover: workpiece(0xf6c089, { roughness: 0.5 }),
  hoverSelected: workpiece(0xc8640f, { roughness: 0.5 }),
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

/**
 * 选面模式中勾出当前规划中没有生成路径的表面（需求 6.4）：--danger，叠在表面分界线上。分界线是半透明的，
 * 在不透明物体之后才画；这里也设为 transparent（不透明度仍为 1），与分界线同一批绘制，按 renderOrder 画在其后。
 */
export const UNTRACED_MATERIAL = new LineMaterial({
  color: 0xd93025,
  linewidth: 3,
  transparent: true,
  opacity: 1,
})

export const PATH_COLORS = {
  process: 0x1f6feb,
  travel: 0x7f8995,
  progress: 0x1e9e50,
  /** 失败路径：--danger */
  failed: 0xd93025,
}

/**
 * 工艺段为粗实线，空行程为细虚线（线段 18 毫米、间隔 14 毫米），进度为叠在工艺段上的绿线，
 * 失败路径为红色实线（线宽 3 像素，不画箭头，不参与进度着色）。
 */
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
  failed: new LineMaterial({ color: PATH_COLORS.failed, linewidth: 3 }),
}

/** 线宽以屏幕像素计的材质，画布尺寸变化时由场景更新分辨率。 */
export const SCREEN_LINE_MATERIALS: readonly LineMaterial[] = [
  BOUNDARY_MATERIAL,
  UNTRACED_MATERIAL,
  ...Object.values(PATH_MATERIALS),
]

/**
 * 线条画的折角"›"：尖端沿 +X，两臂在 XY 平面内向后对称张开，正面朝 +Z。单位为像素：尖端到两臂末端沿 X 长
 * length，两臂末端相距 2 × halfWidth，线宽 stroke（以中心线计）。两臂在尖端斜接，两个四边形只共用一条边、
 * 不重叠，半透明时颜色均匀。中心线的尖端在 x = length / 2，两臂末端在 x = −length / 2。
 */
export function chevronGeometry(length: number, halfWidth: number, stroke: number): BufferGeometry {
  const arm = Math.hypot(length, halfWidth)
  const w = stroke / 2
  // 外侧、内侧的尖角在中心线尖端前后 w / sin(半张角) 处；(nx, ±ny) 为两臂朝外的单位法向
  const miter = (w * arm) / halfWidth
  const nx = halfWidth / arm
  const ny = length / arm
  const tip = length / 2
  const end = -length / 2
  const outline: [number, number][] = [
    [tip + miter, 0], // 0 外尖角
    [tip - miter, 0], // 1 内尖角
    [end + w * nx, halfWidth + w * ny], // 2 上臂末端外侧
    [end - w * nx, halfWidth - w * ny], // 3 上臂末端内侧
    [end + w * nx, -halfWidth - w * ny], // 4 下臂末端外侧
    [end - w * nx, -halfWidth + w * ny], // 5 下臂末端内侧
  ]
  const positions = new Float32Array(outline.flatMap(([x, y]) => [x, y, 0]))
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(positions, 3))
  // 从 +Z 看逆时针：上臂 0-2-3-1，下臂 0-1-5-4
  geometry.setIndex([0, 2, 3, 0, 3, 1, 0, 1, 5, 0, 5, 4])
  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()
  return geometry
}

/**
 * 方向箭头：线条画的折角"›"，尖端指向行进方向，两臂跨在路径线两侧。大小与线宽一样以屏幕像素计：几何体的单位
 * 是像素，场景每次绘制前按相机把每个箭头摆成与屏幕平行、尖端沿路径在屏幕上的方向，并按箭头处的深度换算成米
 * （path.ts 的 fitArrows），缩放和旋转视角时形状和大小都不变。半透明、不写深度；仍参与深度测试，被工件挡住的
 * 不显示。空行程的箭头小一号。
 */
export const ARROW_SHAPE = { length: 6, halfWidth: 6.5, stroke: 2 }
export const ARROW_GEOMETRY = chevronGeometry(
  ARROW_SHAPE.length,
  ARROW_SHAPE.halfWidth,
  ARROW_SHAPE.stroke,
)
export const TRAVEL_ARROW_SCALE = 0.75

/** 箭头的顶点到中心（路径点）的最大距离，像素。 */
function arrowRadius(): number {
  const position = ARROW_GEOMETRY.getAttribute('position')
  let radius = 0
  for (let i = 0; i < position.count; i++) {
    radius = Math.max(radius, Math.hypot(position.getX(i), position.getY(i)))
  }
  return radius
}

/**
 * 箭头沿视线朝相机前移的距离，以箭头处的像素计。箭头与屏幕平行，斜看表面时，朝屏幕下方伸出的部分会低于表面；
 * 前移箭头半径的 2 倍，视线与表面的夹角不小于约 27°（默认视角下圆台顶面约 30°）时箭头不会被表面挡住。
 */
export const ARROW_LIFT_PX = 2 * arrowRadius()

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
