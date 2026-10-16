/**
 * 轨迹动画和路径进度的时间计算（需求 6.5、6.6；架构设计 5.7）。
 * 规划文件中的时间严格递增（接口文档 11.2），用二分查找定位。
 */

/** times 中不大于 t 的最后一个下标；t 小于第一个时间，或数组为空时为 -1。 */
export function lastIndexAtOrBefore(times: ArrayLike<number>, t: number): number {
  let lo = 0
  let hi = times.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if ((times[mid] as number) <= t) {
      found = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return found
}

/**
 * 按时间对相邻两个轨迹点做线性插值，结果写入 out（长度为 joints）。
 * positions 按点依次存放各关节的值；t 超出时间范围时取第一个或最后一个点。
 */
export function interpolateJoints(
  times: ArrayLike<number>,
  positions: ArrayLike<number>,
  joints: number,
  t: number,
  out: { [index: number]: number },
): void {
  const last = times.length - 1
  if (last < 0) return
  const i = lastIndexAtOrBefore(times, t)
  if (i < 0 || i >= last) {
    const base = (i < 0 ? 0 : last) * joints
    for (let j = 0; j < joints; j++) out[j] = positions[base + j] as number
    return
  }
  const t0 = times[i] as number
  const f = (t - t0) / ((times[i + 1] as number) - t0)
  const a = i * joints
  const b = a + joints
  for (let j = 0; j < joints; j++) {
    const p0 = positions[a + j] as number
    out[j] = p0 + ((positions[b + j] as number) - p0) * f
  }
}

/** 到时间 t 为止已经走完的段数。ends 为各段的结束时间，非递减。 */
export function passedCount(ends: ArrayLike<number>, t: number): number {
  return lastIndexAtOrBefore(ends, t) + 1
}
