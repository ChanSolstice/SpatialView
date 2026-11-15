import { beforeEach, describe, expect, it } from 'vitest'
import { createAppStore, type AppStore } from '../store/store.ts'
import { EMPTY_RESULT, makeState, stateForPhase } from '../testing/fixtures.ts'
import { createStateSync, RESTART_NOTICE, type StateSync } from './stateSync.ts'

let store: AppStore
let sync: StateSync

beforeEach(() => {
  store = createAppStore()
  sync = createStateSync(store)
})

const result = (id: string) => ({
  ...EMPTY_RESULT,
  id,
  operation: 'PLAN',
  result: 'FAILED',
  code: 'NO_SOLUTION',
})

describe('stateSync（架构设计 5.4）', () => {
  it('校验通过后写入状态和 seq', () => {
    const state = makeState({ seq: 7 })
    expect(sync(state, 'get')).toEqual(state)
    expect(store.getState().server).toEqual(state)
    expect(store.getState().conn).toMatchObject({ sessionId: 'session-a', seq: 7 })
  })

  it('校验失败视为接口不匹配：记录原因，不写入', () => {
    sync(makeState({ seq: 1 }), 'get')
    expect(sync({ ...makeState({ seq: 2 }), robot_state: 3 }, 'topic')).toBeNull()
    expect(store.getState().contractError).toContain('robot_state')
    expect(store.getState().server?.seq).toBe(1)
    // 之后收到合规的状态即恢复
    sync(makeState({ seq: 3 }), 'topic')
    expect(store.getState().contractError).toBeNull()
  })

  it('缺少字段、不是对象都算不匹配', () => {
    const { last_result: _, ...missing } = makeState()
    expect(sync(missing, 'topic')).toBeNull()
    expect(sync(undefined, 'command')).toBeNull()
    expect(store.getState().contractError).toContain('服务回复')
  })

  it('丢弃 seq 小于当前值的消息，接受相等的（需求 7.6）', () => {
    sync(makeState({ seq: 5, phase: 'PLANNING' }), 'command')
    expect(sync(makeState({ seq: 4, phase: 'MODEL_READY' }), 'topic')).toBeNull()
    expect(store.getState().server?.phase).toBe('PLANNING')
    expect(sync(makeState({ seq: 5, phase: 'PLANNING' }), 'topic')).not.toBeNull()
  })

  describe('服务端重启（需求 7.5）', () => {
    it('之前已有模型时提示，并接受新会话的任何 seq', () => {
      sync(stateForPhase('PLAN_READY', { seq: 900 }), 'topic')
      sync(makeState({ session_id: 'session-b', seq: 1 }), 'topic')
      expect(store.getState().conn).toMatchObject({ sessionId: 'session-b', seq: 1 })
      expect(store.getState().dialogs).toMatchObject([{ kind: 'info', ...RESTART_NOTICE }])
    })

    it('之前没有模型时不提示', () => {
      sync(makeState({ seq: 30 }), 'topic')
      sync(makeState({ session_id: 'session-b', seq: 1 }), 'topic')
      expect(store.getState().dialogs).toEqual([])
    })

    it('APP 启动后的第一份状态不提示', () => {
      sync(stateForPhase('PLAN_READY', { seq: 40 }), 'get')
      expect(store.getState().dialogs).toEqual([])
    })
  })

  describe('操作结果（需求 5.5）', () => {
    it('APP 启动后的第一份状态只记录 id，之后 id 变化时弹框', () => {
      sync(makeState({ seq: 1, last_result: result('r1') }), 'get')
      expect(store.getState().lastResultId).toBe('r1')
      expect(store.getState().dialogs).toEqual([])

      sync(makeState({ seq: 2, last_result: result('r1') }), 'topic')
      expect(store.getState().dialogs).toEqual([])

      sync(makeState({ seq: 3, last_result: result('r2') }), 'topic')
      expect(store.getState().lastResultId).toBe('r2')
      expect(store.getState().dialogs).toMatchObject([
        { kind: 'result', notice: { title: '规划失败', reason: '所选表面均无法生成清洗路径' } },
      ])
    })

    it('断线重连不清除记录：断线期间产生的结果在重连后照常提示', () => {
      sync(makeState({ seq: 1, last_result: result('r1') }), 'topic')
      store.getState().setConn({ status: 'reconnecting' })
      sync(makeState({ seq: 20, last_result: result('r2') }), 'get')
      expect(store.getState().dialogs).toHaveLength(1)
    })
  })
})
