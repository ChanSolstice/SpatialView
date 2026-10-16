/** 默认视角的计算（需求 6.2）。 */
import { Vector3 } from 'three'

/** 无模型时的观察范围半径，米：看清 default_target 周围的地面网格。 */
export const EMPTY_RADIUS = 0.5

/** 工件完整充满画面时相机到包围球中心的距离，留 5% 的边。 */
export function fitDistance(radius: number, fovDegrees: number, aspect: number): number {
  const vertical = (fovDegrees * Math.PI) / 180
  const horizontal = 2 * Math.atan(Math.tan(vertical / 2) * aspect)
  return (radius / Math.sin(Math.min(vertical, horizontal) / 2)) * 1.05
}

/** 默认视角下的相机位置：从观察中心沿配置的方向退到 fitDistance。 */
export function defaultCameraPosition(
  target: Vector3,
  direction: readonly [number, number, number],
  distance: number,
): Vector3 {
  return new Vector3(...direction).normalize().multiplyScalar(distance).add(target)
}
