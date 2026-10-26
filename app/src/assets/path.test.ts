import { Color, type InstancedMesh, Matrix4, Vector3 } from 'three'
import type { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js'
import { describe, expect, it } from 'vitest'
import { testPlanJson } from '../testing/plan.ts'
import { PATH_COLORS, PATH_MATERIALS } from './materials.ts'
import { buildPath } from './path.ts'
import { parsePlan } from './plan.ts'

const IDS = { planId: 'plan_a', modelId: 'model_a' }
// 0–10 秒，0–5 秒为工艺段（5 段），之后为空行程（5 段）；每段 0.02 米
const build = () => buildPath(parsePlan(testPlanJson(IDS), IDS, 0.02))

const child = <T>(plan: ReturnType<typeof build>, name: string) =>
  plan.group.getObjectByName(name) as T

describe('buildPath', () => {
  it('每类线段一个对象：工艺段、空行程段、进度线、两组箭头', () => {
    const plan = build()
    expect(plan.group.children.map((c) => c.name)).toEqual([
      'process',
      'travel',
      'progress',
      'process-arrows',
      'travel-arrows',
    ])
    expect(child<LineSegments2>(plan, 'process').material).toBe(PATH_MATERIALS.process)
    expect(child<LineSegments2>(plan, 'travel').material).toBe(PATH_MATERIALS.travel)
    expect(child<InstancedMesh>(plan, 'process-arrows').count).toBe(5)
    expect(child<InstancedMesh>(plan, 'travel-arrows').count).toBe(5)
    expect(plan.start.toArray()).toEqual([0.3, 0.05, 0.1])
    expect(plan.end.x).toBeCloseTo(0.5, 6)
    expect(plan.sphere.center.x).toBeCloseTo(0.4, 6)
  })

  it('箭头的大小与间距成比例：间距 0.16 米时为原始大小', () => {
    const scale = (plan: ReturnType<typeof build>) => {
      const matrix = new Matrix4()
      child<InstancedMesh>(plan, 'process-arrows').getMatrixAt(0, matrix)
      return new Vector3().setFromMatrixScale(matrix).toArray()
    }
    expect(scale(build())).toEqual([0.125, 0.125, 0.125].map((v) => expect.closeTo(v, 9)))
    const reference = buildPath(parsePlan(testPlanJson(IDS), IDS, 0.16))
    expect(scale(reference)).toEqual([1, 1, 1].map((v) => expect.closeTo(v, 9)))
  })

  it('进度：已走过的工艺段叠加绿线，对应的箭头变绿；null 时恢复', () => {
    const plan = build()
    const progress = child<LineSegments2>(plan, 'progress')
    const arrows = child<InstancedMesh>(plan, 'process-arrows')
    const color = (i: number) => {
      const c = new Color()
      arrows.getColorAt(i, c)
      return c.getHex()
    }
    expect(progress.visible).toBe(false)

    plan.setProgress(2.6)
    expect(progress.visible).toBe(true)
    expect(progress.geometry.instanceCount).toBe(2)
    // 箭头在每段中点：0.5、1.5、2.5 秒处的已变绿
    expect([0, 1, 2, 3, 4].map(color)).toEqual([
      PATH_COLORS.progress,
      PATH_COLORS.progress,
      PATH_COLORS.progress,
      PATH_COLORS.process,
      PATH_COLORS.process,
    ])

    // 空行程段不着色：走到最后，绿线只有 5 段工艺段
    plan.setProgress(10)
    expect(progress.geometry.instanceCount).toBe(5)
    expect(color(4)).toBe(PATH_COLORS.progress)

    plan.setProgress(1)
    expect(progress.geometry.instanceCount).toBe(1)
    expect([color(0), color(1)]).toEqual([PATH_COLORS.progress, PATH_COLORS.process])

    plan.setProgress(null)
    expect(progress.visible).toBe(false)
    expect(color(0)).toBe(PATH_COLORS.process)
  })

  it('释放几何体，不释放共享材质', () => {
    const plan = build()
    const disposed: string[] = []
    for (const name of ['process', 'travel', 'progress']) {
      child<LineSegments2>(plan, name).geometry.addEventListener('dispose', () =>
        disposed.push(name),
      )
    }
    let materialDisposed = false
    PATH_MATERIALS.process.addEventListener('dispose', () => (materialDisposed = true))
    plan.dispose()
    expect(disposed).toEqual(['process', 'travel', 'progress'])
    expect(materialDisposed).toBe(false)
  })
})
