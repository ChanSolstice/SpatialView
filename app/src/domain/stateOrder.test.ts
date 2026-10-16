import { describe, expect, it } from 'vitest'
import { orderState } from './stateOrder.ts'

describe('orderState（需求 7.6）', () => {
  it('APP 启动后的第一份状态', () => {
    expect(orderState({ sessionId: null, seq: 0 }, 'a', 57)).toBe('first')
  })

  it('同一会话：seq 不小于当前值时接受，包括相等（回复与 Topic 的 seq 相同）', () => {
    const cursor = { sessionId: 'a', seq: 10 }
    expect(orderState(cursor, 'a', 11)).toBe('accept')
    expect(orderState(cursor, 'a', 10)).toBe('accept')
    expect(orderState(cursor, 'a', 9)).toBe('stale')
  })

  it('session_id 变化时接受任何 seq', () => {
    expect(orderState({ sessionId: 'a', seq: 500 }, 'b', 1)).toBe('restarted')
  })
})
