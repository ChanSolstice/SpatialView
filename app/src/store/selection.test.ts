import { beforeEach, describe, expect, it } from 'vitest'
import { parseModel } from '../assets/model.ts'
import { buildPath } from '../assets/path.ts'
import { parsePlan } from '../assets/plan.ts'
import { EXPANDED_TITLE } from '../domain/planRange.ts'
import type { SystemState } from '../ros/contract.ts'
import { EMPTY_RESULT, STATE_IDS, stateForPhase } from '../testing/fixtures.ts'
import { buildGlb, gridSurface } from '../testing/glb.ts'
import { testPlanJson, type TestPlanOptions } from '../testing/plan.ts'
import { installListeners } from './listeners.ts'
import { selectPlanRange } from './selectors.ts'
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

  it('新规划生效后再次进入：规划文件没有有效选择时（旧服务端），按新规划的 plan_surface_ids 重新选择', () => {
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

/** 加载当前规划（stateForPhase 的 plan_id）；options 为规划文件中的表面集合等。 */
function loadPlan(options: Partial<TestPlanOptions> = {}, planId = STATE_IDS.plan) {
  const ids = { planId, modelId: MODEL }
  const data = buildPath(parsePlan(testPlanJson({ ...ids, ...options }), ids, 0.05))
  s().setPlan({ id: planId, status: 'loading', error: null })
  s().setPlan({ status: 'ready', data })
}

// 选了 s2，扩展进 s1；s2 整个表面没有生成路径
const EXPANDED = { surfaceIds: ['s1'], selected: ['s2'], planning: ['s1', 's2'] }

describe('规划范围（需求 5.5、6.4）', () => {
  it('进入选面时预先选中有效选择，包括没有生成路径的表面，不选中扩展进来的表面', () => {
    serve(stateForPhase('PLAN_READY', { plan_surface_ids: ['s1'] }))
    loadPlan(EXPANDED)
    s().enterSelect()
    expect([...s().selection]).toEqual(['s2'])
  })

  it('扩展进来的表面和没有生成路径的表面', () => {
    serve(stateForPhase('PLAN_READY', { plan_surface_ids: ['s1'] }))
    loadPlan(EXPANDED)
    const range = selectPlanRange(s())
    expect(range).toMatchObject({ selected: 1, scope: 2 })
    expect([...(range?.expanded ?? [])]).toEqual(['s1'])
    expect([...(range?.untraced ?? [])]).toEqual(['s2'])
    // 输入不变时返回同一个对象
    expect(selectPlanRange(s())).toBe(range)
  })

  it('规划文件没有表面集合、或者已加载的不是当前规划时没有规划范围', () => {
    serve(stateForPhase('PLAN_READY'))
    loadPlan()
    expect(selectPlanRange(s())).toBeNull()
    loadPlan(EXPANDED, 'plan_old')
    expect(selectPlanRange(s())).toBeNull()
    s().enterSelect()
    expect([...s().selection]).toEqual(['s1', 's2'])
  })

  describe('规划加载后说明规划范围', () => {
    const partial = () => ({
      kind: 'result' as const,
      notice: {
        title: '部分路径未能规划',
        tone: 'partial' as const,
        reason: '',
        detail: '',
        code: 'PLAN_PARTIAL',
        resumable: false,
        planId: STATE_IDS.plan,
      },
    })

    beforeEach(() => {
      serve(stateForPhase('PLAN_READY', { last_result: { ...EMPTY_RESULT, id: 'r1' } }))
      s().setPlanNotice(STATE_IDS.plan)
    })

    it('有扩展、没有部分路径未能规划的提示框时，单独弹出规划范围已扩展', () => {
      loadPlan(EXPANDED)
      expect(s().planNotice).toBeNull()
      expect(s().dialogs).toMatchObject([
        {
          kind: 'info',
          title: EXPANDED_TITLE,
          text:
            '规划范围按连续曲面从选择的 1 个表面扩展到 2 个，点击"选面"可以查看，扩展的表面为浅蓝色。' +
            '其中 1 个表面没有生成路径，选面时以红色边框标出。',
        },
      ])
    })

    it('部分路径未能规划的提示框还在时，由它显示说明，不另外弹框', () => {
      s().pushDialog(partial())
      loadPlan(EXPANDED)
      expect(s().dialogs.map((d) => d.kind)).toEqual(['result'])
      expect(s().planNotice).toBeNull()
    })

    it('没有扩展时不弹框', () => {
      loadPlan({ surfaceIds: ['s1'], selected: ['s1', 's2'], planning: ['s1', 's2'] })
      expect(s().dialogs).toEqual([])
      expect(s().planNotice).toBeNull()
    })

    it('加载其他规划时不说明；这次的规划加载失败时清除，不说明', () => {
      loadPlan(EXPANDED, 'plan_other')
      expect(s().planNotice).toBe(STATE_IDS.plan)
      s().setPlan({ id: STATE_IDS.plan, status: 'loading', error: null })
      s().setPlan({ status: 'error', data: null, error: '下载失败' })
      expect(s().planNotice).toBeNull()
      expect(s().dialogs).toEqual([])
    })
  })
})
