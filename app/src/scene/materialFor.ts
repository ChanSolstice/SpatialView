/** 表面在各场景模式下使用的共享材质（需求 6.3、6.4；前端UI设计第 5 节）。 */
import type { Material } from 'three'
import { WORKPIECE_MATERIALS } from '../assets/materials.ts'
import type { LoadedModel } from '../assets/model.ts'
import type { SceneContent } from '../domain/phase.ts'

export function materialFor(
  workpiece: SceneContent['workpiece'],
  selectable: boolean,
  selected: boolean,
): Material {
  if (workpiece === 'faded') return WORKPIECE_MATERIALS.faded
  if (workpiece !== 'selectable') return WORKPIECE_MATERIALS.normal
  // 不可处理的表面只在选面模式中以深灰色显示
  if (!selectable) return WORKPIECE_MATERIALS.unselectable
  return selected ? WORKPIECE_MATERIALS.selected : WORKPIECE_MATERIALS.normal
}

/** 按场景模式和选择替换各表面的材质引用，选面模式中显示表面分界线。 */
export function applyAppearance(
  model: LoadedModel,
  workpiece: SceneContent['workpiece'],
  selection: ReadonlySet<string>,
): void {
  for (const surface of model.surfaces.values()) {
    surface.mesh.material = materialFor(workpiece, surface.selectable, selection.has(surface.id))
  }
  model.boundaries.visible = workpiece === 'selectable'
}
