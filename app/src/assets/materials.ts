/**
 * 工件和表面分界线的共享材质（前端UI设计第 5 节；架构设计 5.7）。只建这几个，切换时替换 mesh 的材质引用，
 * 不新建材质；随 APP 常驻，不随模型释放。
 */
import { DoubleSide, MeshStandardMaterial, type MeshStandardMaterialParameters } from 'three'
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
