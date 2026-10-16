import { beforeEach, describe, expect, it } from 'vitest'
import { parseModel } from '../assets/model.ts'
import type { SystemState } from '../ros/contract.ts'
import { stateForPhase } from '../testing/fixtures.ts'
import { buildGlb, gridSurface } from '../testing/glb.ts'
import { installListeners } from './listeners.ts'
import { createAppStore, type AppStore } from './store.ts'

const MODEL = 'model_20261015T080000'
let store: AppStore
let seq = 1
const s = () => store.getState()

function serve(state: SystemState) {
  s().setServer({ ...state, seq: seq }, { sessionId: state.session_id, seq: seq++ })
}

beforeEach(async () => {
  seq = 1
  store = createAppStore({
    conn: { status: 'connected', socketOpen: true, sessionId: null, seq: 0 },
  })
  installListeners(store)
  const data = await parseModel(
    buildGlb(
      [
        gridSurface('s1', 0.3, 0, 0.1),
        gridSurface('s2', 0.4, 0, 0.1),
        { ...gridSurface('s3', 0.3, 0.1, 0.1), selectable: false },
      ],
      { model_id: MODEL },
    ),
    MODEL,
  )
  s().setModel({ id: MODEL, status: 'ready', data })
})

describe('选面（需求 6.4）', () => {
  it('进入时没有规划：选择为空，相机恢复默认视角', () => {
    serve(stateForPhase('MODEL_READY'))
    const resets = s().viewResets
    s().enterSelect()
    expect(s().mode).toBe('select')
    expect([...s().selection]).toEqual([])
    expect(s().viewResets).toBe(resets + 1)
  })

  it('进入时已有规划：预先选中该规划使用的表面', () => {
    serve(stateForPhase('PLAN_READY', { plan_surface_ids: ['s2', 's3', 'gone'] }))
    s().enterSelect()
    // 只保留模型中存在且可选的表面
    expect([...s().selection]).toEqual(['s2'])
  })

  it('点选：未选中则加入，已选中则移除；不可选的表面不响应', () => {
    serve(stateForPhase('MODEL_READY'))
    s().enterSelect()
    s().toggleSurface('s1')
    s().toggleSurface('s2')
    s().toggleSurface('s1')
    s().toggleSurface('s3')
    expect([...s().selection]).toEqual(['s2'])
  })

  it('不在选面模式时点选不响应', () => {
    serve(stateForPhase('MODEL_READY'))
    s().toggleSurface('s1')
    expect(s().selection.size).toBe(0)
  })

  it('选择集合是本地状态：退出后保留，再次进入时继续使用', () => {
    serve(stateForPhase('PLAN_READY'))
    s().enterSelect()
    s().toggleSurface('s1')
    s().setMode('browse')
    expect([...s().selection]).toEqual(['s2'])
    s().enterSelect()
    expect([...s().selection]).toEqual(['s2'])
  })

  it('新规划生效后再次进入：按新规划的表面重新选择（部分表面未能规划时便于找到它们，需求 5.5）', () => {
    serve(stateForPhase('PLAN_READY', { plan_surface_ids: ['s1', 's2'] }))
    s().enterSelect()
    s().setMode('browse')
    serve(stateForPhase('PLAN_READY', { plan_id: 'plan_new', plan_surface_ids: ['s1'] }))
    s().enterSelect()
    expect([...s().selection]).toEqual(['s1'])
  })

  it('模型 ID 变化时清空选择', () => {
    serve(stateForPhase('PLAN_READY'))
    s().enterSelect()
    s().setMode('browse')
    serve(stateForPhase('MODEL_READY', { model_id: 'model_new' }))
    expect(s().selection.size).toBe(0)
    expect(s().selectionBasis).toBeNull()
  })

  it.each(['SCANNING', 'PLANNING', 'NO_MODEL'] as const)('阶段变为 %s 时自动退出选面', (phase) => {
    serve(stateForPhase('PLAN_READY'))
    s().enterSelect()
    serve(stateForPhase(phase))
    expect(s().mode).toBe('browse')
  })

  it('断线本身不退出：server 保留断线前的状态', () => {
    serve(stateForPhase('PLAN_READY'))
    s().enterSelect()
    s().setConn({ status: 'reconnecting' })
    expect(s().mode).toBe('select')
  })
})
