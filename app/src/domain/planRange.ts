/**
 * 规划范围（需求 5.5、6.4；接口文档 6.4、11.1）：比较规划文件中的有效选择、规划范围和有有效轨迹的表面，
 * 得出连续扩展进来的表面和没有生成路径的表面，以及提示中的说明。
 */
import type { PlanScope } from '../assets/plan.ts'

export interface PlanRange {
  /** 有效选择的表面数 */
  selected: number
  /** 规划范围的表面数 */
  scope: number
  /** 连续扩展进来的表面：在规划范围中、不在有效选择中 */
  expanded: ReadonlySet<string>
  /** 没有生成路径的表面：在规划范围中、不在 surface_ids 中 */
  untraced: ReadonlySet<string>
}

/** 规划范围已扩展、部分路径未能规划的提示框都没有时，单独弹出的信息提示框的标题（需求 5.5）。 */
export const EXPANDED_TITLE = '规划范围已扩展'

/** 规划文件没有表面集合（旧服务端）时为 null，不显示扩展，也不据此认为没有扩展（接口文档 11.2）。 */
export function planRange(
  scope: PlanScope | null,
  surfaceIds: readonly string[],
): PlanRange | null {
  if (scope === null) return null
  const selected = new Set(scope.selected)
  const traced = new Set(surfaceIds)
  return {
    selected: selected.size,
    scope: scope.planning.length,
    expanded: new Set(scope.planning.filter((id) => !selected.has(id))),
    untraced: new Set(scope.planning.filter((id) => !traced.has(id))),
  }
}

/** 提示框中规划范围的说明，每项一行；没有扩展、也没有未生成路径的表面时为空。 */
export function rangeLines(range: PlanRange | null): string[] {
  if (range === null) return []
  const lines: string[] = []
  if (range.expanded.size > 0) {
    lines.push(
      `规划范围按连续曲面从选择的 ${range.selected} 个表面扩展到 ${range.scope} 个，` +
        '点击"选面"可以查看，扩展的表面为浅蓝色。',
    )
  }
  if (range.untraced.size > 0) {
    lines.push(`其中 ${range.untraced.size} 个表面没有生成路径，选面时以红色边框标出。`)
  }
  return lines
}
