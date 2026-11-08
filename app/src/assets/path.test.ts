import { Color, type InstancedMesh, Matrix4, PerspectiveCamera, Vector3 } from 'three'
import type { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js'
import { describe, expect, it } from 'vitest'
import { testPlanJson } from '../testing/plan.ts'
import {
  ARROW_COLORS,
  ARROW_GEOMETRY,
  ARROW_MATERIALS,
  PATH_MATERIALS,
  TRAVEL_ARROW_SCALE,
} from './materials.ts'
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

  it('箭头以屏幕像素计：按相机到路径中心的距离缩放几何体，与间距无关；空行程的箭头小一号', () => {
    const plan = build()
    const processArrows = child<InstancedMesh>(plan, 'process-arrows')
    const travelArrows = child<InstancedMesh>(plan, 'travel-arrows')
    const length = (geometry = processArrows.geometry) => {
      geometry.computeBoundingBox()
      return geometry.boundingBox?.getSize(new Vector3()).y
    }
    const pixels = ARROW_GEOMETRY.parameters.height
    // 每个规划一份几何体，两组共用；按相机调整之前不显示
    expect(travelArrows.geometry).toBe(processArrows.geometry)
    expect(length()).toBe(0)

    // 视场角 90°、画布高 500 像素：距相机 d 米处 1 像素为 2d / 500 米。几何体为单精度，比较到微米
    const camera = new PerspectiveCamera(90, 1.5, 0.01, 50)
    const at = (distance: number) =>
      camera.position.copy(plan.sphere.center).add(new Vector3(0, 0, distance))
    at(1)
    plan.fitArrows(camera, 500)
    expect(length()).toBeCloseTo((pixels * 2) / 500, 6)
    at(2)
    plan.fitArrows(camera, 500)
    expect(length()).toBeCloseTo((pixels * 4) / 500, 6)
    // 共享的几何体不变
    expect(length(ARROW_GEOMETRY)).toBeCloseTo(pixels, 5)

    const scale = (mesh: InstancedMesh) => {
      const matrix = new Matrix4()
      mesh.getMatrixAt(0, matrix)
      return new Vector3().setFromMatrixScale(matrix).x
    }
    expect(scale(processArrows)).toBeCloseTo(1, 9)
    expect(scale(travelArrows)).toBeCloseTo(TRAVEL_ARROW_SCALE, 9)

    const sparse = buildPath(parsePlan(testPlanJson(IDS), IDS, 0.08))
    const sparseArrows = child<InstancedMesh>(sparse, 'process-arrows')
    sparse.fitArrows(camera, 500)
    expect(sparseArrows.count).toBe(1)
    expect(length(sparseArrows.geometry)).toBeCloseTo(
      ((pixels * 2) / 500) * camera.position.distanceTo(sparse.sphere.center),
      6,
    )
  })

  it('箭头沿各自的视线朝相机前移，路径中心处前移半个箭头长，屏幕上的位置不变', () => {
    const plan = build()
    const arrows = child<InstancedMesh>(plan, 'process-arrows')
    const camera = new PerspectiveCamera(38, 980 / 736, 0.01, 50)
    camera.position.set(1, -1, 0.8)
    camera.lookAt(plan.sphere.center)
    camera.updateMatrixWorld()
    plan.fitArrows(camera, 736)
    plan.group.updateMatrixWorld(true)

    const instance = new Matrix4()
    for (const i of [0, 4]) {
      arrows.getMatrixAt(i, instance)
      const original = new Vector3().setFromMatrixPosition(instance)
      const shown = original.clone().applyMatrix4(arrows.matrixWorld)
      const toCamera = camera.position.clone().sub(original)
      const moved = shown.clone().sub(original)
      expect(moved.clone().cross(toCamera).length()).toBeCloseTo(0, 9)
      expect(moved.dot(toCamera)).toBeGreaterThan(0)
      const screen = (v: Vector3) => v.clone().project(camera).toArray().slice(0, 2)
      expect(screen(shown)).toEqual(screen(original).map((v) => expect.closeTo(v, 9)))
    }
    const meters =
      ((2 * Math.tan((19 * Math.PI) / 180)) / 736) * camera.position.distanceTo(plan.sphere.center)
    const center = plan.sphere.center.clone().applyMatrix4(arrows.matrixWorld)
    expect(center.distanceTo(plan.sphere.center)).toBeCloseTo(
      (ARROW_GEOMETRY.parameters.height / 2) * meters,
      9,
    )
    expect(child<InstancedMesh>(plan, 'travel-arrows').matrixWorld.equals(arrows.matrixWorld)).toBe(
      true,
    )
  })

  it('箭头半透明、不写深度，仍参与深度测试', () => {
    for (const material of Object.values(ARROW_MATERIALS)) {
      expect(material.transparent).toBe(true)
      expect(material.opacity).toBeLessThan(1)
      expect(material.depthWrite).toBe(false)
      expect(material.depthTest).toBe(true)
    }
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
      ARROW_COLORS.progress,
      ARROW_COLORS.progress,
      ARROW_COLORS.progress,
      ARROW_COLORS.process,
      ARROW_COLORS.process,
    ])

    // 空行程段不着色：走到最后，绿线只有 5 段工艺段
    plan.setProgress(10)
    expect(progress.geometry.instanceCount).toBe(5)
    expect(color(4)).toBe(ARROW_COLORS.progress)

    plan.setProgress(1)
    expect(progress.geometry.instanceCount).toBe(1)
    expect([color(0), color(1)]).toEqual([ARROW_COLORS.progress, ARROW_COLORS.process])

    plan.setProgress(null)
    expect(progress.visible).toBe(false)
    expect(color(0)).toBe(ARROW_COLORS.process)
  })

  it('释放几何体（包括箭头的），不释放共享材质', () => {
    const plan = build()
    const disposed: string[] = []
    for (const name of ['process', 'travel', 'progress', 'process-arrows']) {
      child<LineSegments2>(plan, name).geometry.addEventListener('dispose', () =>
        disposed.push(name),
      )
    }
    let materialDisposed = false
    PATH_MATERIALS.process.addEventListener('dispose', () => (materialDisposed = true))
    ARROW_MATERIALS.process.addEventListener('dispose', () => (materialDisposed = true))
    plan.dispose()
    expect(disposed).toEqual(['process', 'travel', 'progress', 'process-arrows'])
    expect(materialDisposed).toBe(false)
  })
})
