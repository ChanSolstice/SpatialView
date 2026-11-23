/** 表面在各场景模式下使用的共享材质（需求 6.3、6.4；前端UI设计第 5 节）。 */
import type { Material } from 'three'
import { WORKPIECE_MATERIALS } from '../assets/materials.ts'
import type { LoadedModel } from '../assets/model.ts'
import type { SceneContent } from '../domain/phase.ts'

/**
 * hovered 为选面模式中鼠标指向该表面（需求 6.4 的悬停预览）；expanded 为当前规划连续扩展进来的表面，
 * 未选中时显示扩展色，选中后与其他选中的表面相同。
 */
export function materialFor(
  workpiece: SceneContent['workpiece'],
  selectable: boolean,
  selected: boolean,
  hovered = false,
  expanded = false,
): Material {
  if (workpiece === 'faded') return WORKPIECE_MATERIALS.faded
  if (workpiece !== 'selectable') return WORKPIECE_MATERIALS.normal
  // 不可处理的表面只在选面模式中以深灰色显示，没有悬停预览
  if (!selectable) return WORKPIECE_MATERIALS.unselectable
  if (hovered) return selected ? WORKPIECE_MATERIALS.hoverSelected : WORKPIECE_MATERIALS.hover
  if (selected) return WORKPIECE_MATERIALS.selected
  return expanded ? WORKPIECE_MATERIALS.expanded : WORKPIECE_MATERIALS.normal
}

const NONE: ReadonlySet<string> = new Set()

/**
 * 按场景模式、选择、鼠标指向的表面和当前规划扩展进来的表面替换各表面的材质引用，选面模式中显示表面分界线。
 */
export function applyAppearance(
  model: LoadedModel,
  workpiece: SceneContent['workpiece'],
  selection: ReadonlySet<string>,
  hovered: string | null = null,
  expanded: ReadonlySet<string> = NONE,
): void {
  for (const surface of model.surfaces.values()) {
    surface.mesh.material = materialFor(
      workpiece,
      surface.selectable,
      selection.has(surface.id),
      surface.id === hovered,
      expanded.has(surface.id),
    )
  }
  model.boundaries.visible = workpiece === 'selectable'
}
