/** 界面上的数字格式。 */

/** 播放条上的时间：分:秒，分钟不设上限（例如 82:03）。 */
export function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const minutes = Math.floor(total / 60)
  return `${String(minutes).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}
