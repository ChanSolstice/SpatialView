import { describe, expect, it } from 'vitest'
import { interpolateJoints, lastIndexAtOrBefore, passedCount } from './interpolation.ts'

describe('lastIndexAtOrBefore', () => {
  const times = [0, 0.1, 0.25, 1]

  it('等于某个时间时取该点，落在两点之间时取前一个', () => {
    expect(lastIndexAtOrBefore(times, 0)).toBe(0)
    expect(lastIndexAtOrBefore(times, 0.1)).toBe(1)
    expect(lastIndexAtOrBefore(times, 0.2)).toBe(1)
    expect(lastIndexAtOrBefore(times, 1)).toBe(3)
  })

  it('超出范围', () => {
    expect(lastIndexAtOrBefore(times, -0.5)).toBe(-1)
    expect(lastIndexAtOrBefore(times, 5)).toBe(3)
    expect(lastIndexAtOrBefore([], 1)).toBe(-1)
  })

  it('与逐个比较的结果一致', () => {
    const many = Float64Array.from({ length: 1000 }, (_, i) => i * 0.1 + (i % 7) * 0.001)
    for (const t of [0.05, 3.333, 49.9, 99.95, 120]) {
      let expected = -1
      many.forEach((v, i) => {
        if (v <= t) expected = i
      })
      expect(lastIndexAtOrBefore(many, t)).toBe(expected)
    }
  })
})

describe('interpolateJoints', () => {
  // 两个关节、三个点
  const times = [0, 1, 3]
  const positions = [0, 10, 1, 20, 3, 0]

  it('相邻两点线性插值', () => {
    const out = [0, 0]
    interpolateJoints(times, positions, 2, 0.5, out)
    expect(out).toEqual([0.5, 15])
    interpolateJoints(times, positions, 2, 2, out)
    expect(out).toEqual([2, 10])
  })

  it('落在点上时取该点', () => {
    const out = new Float64Array(2)
    interpolateJoints(times, positions, 2, 1, out)
    expect([...out]).toEqual([1, 20])
  })

  it('超出时间范围时取第一个或最后一个点', () => {
    const out = [9, 9]
    interpolateJoints(times, positions, 2, -1, out)
    expect(out).toEqual([0, 10])
    interpolateJoints(times, positions, 2, 3, out)
    expect(out).toEqual([3, 0])
    interpolateJoints(times, positions, 2, 99, out)
    expect(out).toEqual([3, 0])
  })

  it('不做 ±π 回绕：关节角按文件中的连续值插值（接口文档 11.2）', () => {
    const out = [0]
    interpolateJoints([0, 1], [3.1, 3.3], 1, 0.5, out)
    expect(out[0]).toBeCloseTo(3.2, 12)
  })
})

describe('passedCount', () => {
  const ends = [0.1, 0.2, 0.2, 0.5]

  it('结束时间不大于 t 的段都算走完', () => {
    expect(passedCount(ends, 0)).toBe(0)
    expect(passedCount(ends, 0.1)).toBe(1)
    expect(passedCount(ends, 0.3)).toBe(3)
    expect(passedCount(ends, 9)).toBe(4)
  })
})
