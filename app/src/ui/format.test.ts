import { describe, expect, it } from 'vitest'
import { formatClock } from './format.ts'

describe('formatClock', () => {
  it('分:秒，不足一秒的部分舍去，分钟不设上限', () => {
    expect(formatClock(0)).toBe('00:00')
    expect(formatClock(9.99)).toBe('00:09')
    expect(formatClock(66.4)).toBe('01:06')
    expect(formatClock(4922.9)).toBe('82:02')
    expect(formatClock(-1)).toBe('00:00')
  })
})
