/**
 * 状态消息的接受规则（需求 7.6、7.5）：只应用 seq 不小于当前值的消息；session_id 变化时重新计数，
 * 接受任何 seq，并说明服务端重启过。
 */

export interface StateCursor {
  /** APP 启动后还没有收到过状态时为 null。 */
  sessionId: string | null
  seq: number
}

/**
 * first：APP 启动后的第一份状态；restarted：session_id 变化，服务端重启过；
 * accept：同一会话中不旧于当前的状态；stale：旧消息，丢弃。
 */
export type OrderDecision = 'first' | 'restarted' | 'accept' | 'stale'

export function orderState(cursor: StateCursor, sessionId: string, seq: number): OrderDecision {
  if (cursor.sessionId === null) return 'first'
  if (sessionId !== cursor.sessionId) return 'restarted'
  return seq >= cursor.seq ? 'accept' : 'stale'
}
