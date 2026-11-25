import { Color, type InstancedMesh, Line3, Matrix4, PerspectiveCamera, Vector3 } from 'three'
import type { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js'
import { describe, expect, it } from 'vitest'
import { testPlanJson } from '../testing/plan.ts'
import {
  ARROW_COLORS,
  ARROW_GEOMETRY,
  ARROW_LIFT_PX,
  ARROW_MATERIALS,
  PATH_MATERIALS,
  SCREEN_LINE_MATERIALS,
  TRAVEL_ARROW_SCALE,
  chevronGeometry,
} from './materials.ts'
import { buildPath } from './path.ts'
import { parsePlan } from './plan.ts'

const IDS = { planId: 'plan_a', modelId: 'model_a' }
// 0–10 秒，0–5 秒为工艺段（5 段），之后为空行程（5 段）；每段 0.02 米，沿 +X
const build = (spacing = 0.02) => buildPath(parsePlan(testPlanJson(IDS), IDS, spacing))
// 两段失败路径：在路径旁边沿 Y 方向
const FAILED_PATHS = [
  [
    [0.35, 0.1, 0.1],
    [0.35, 0.12, 0.1],
    [0.35, 0.14, 0.1],
  ],
  [
    [0.45, 0.1, 0.1],
    [0.45, 0.12, 0.1],
  ],
]
const buildWithFailed = () => {
  const options = { ...IDS, failedPaths: FAILED_PATHS }
  return buildPath(parsePlan(testPlanJson(options), IDS, 0.02))
}

const child = <T>(plan: ReturnType<typeof build>, name: string) =>
  plan.group.getObjectByName(name) as T

// 画布 980 × 736 像素，视场角 38°（与场景相同）
const WIDTH = 980
const HEIGHT = 736
const UNIT = (2 * Math.tan((19 * Math.PI) / 180)) / HEIGHT

/** 从 offset 方向看路径中心的相机。 */
function cameraLooking(plan: ReturnType<typeof build>, offset: Vector3): PerspectiveCamera {
  const camera = new PerspectiveCamera(38, WIDTH / HEIGHT, 0.01, 50)
  camera.position.copy(plan.sphere.center).add(offset)
  camera.lookAt(plan.sphere.center)
  camera.updateMatrixWorld()
  return camera
}

/** 点在画布上的像素坐标；z 为深度缓冲中的值。 */
function toScreen(point: Vector3, camera: PerspectiveCamera): Vector3 {
  const p = point.clone().project(camera)
  return new Vector3(((p.x + 1) * WIDTH) / 2, ((1 - p.y) * HEIGHT) / 2, p.z)
}

const instanceMatrix = (mesh: InstancedMesh, i: number) => {
  const matrix = new Matrix4()
  mesh.getMatrixAt(i, matrix)
  return matrix
}

const geometryVertices = (mesh: InstancedMesh) => {
  const position = mesh.geometry.getAttribute('position')
  return Array.from({ length: position.count }, (_, v) =>
    new Vector3().fromBufferAttribute(position, v),
  )
}

/** 第 i 个箭头的顶点在画布上的像素坐标。 */
const screenVertices = (mesh: InstancedMesh, i: number, camera: PerspectiveCamera) =>
  geometryVertices(mesh).map((v) => toScreen(v.applyMatrix4(instanceMatrix(mesh, i)), camera))

const arrowPosition = (plan: ReturnType<typeof build>, i: number) =>
  new Vector3().fromArray(plan.data.processArrows.positions, i * 3)

describe('buildPath', () => {
  it('每类线段一个对象：工艺段、空行程段、失败路径、进度线、两组箭头', () => {
    const plan = build()
    expect(plan.group.children.map((c) => c.name)).toEqual([
      'process',
      'travel',
      'failed',
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

  it('箭头与屏幕平行，尖端沿路径在屏幕上的方向；大小以像素计，与远近、间距无关；空行程的小一号', () => {
    const plan = build()
    const processArrows = child<InstancedMesh>(plan, 'process-arrows')
    const travelArrows = child<InstancedMesh>(plan, 'travel-arrows')
    expect(travelArrows.geometry).toBe(processArrows.geometry)
    const pixels = geometryVertices(processArrows)

    const check = (
      target: ReturnType<typeof build>,
      mesh: InstancedMesh,
      i: number,
      camera: PerspectiveCamera,
      size: number,
    ) => {
      const shown = screenVertices(mesh, i, camera)
      const [tip, upperEnd, lowerEnd] = [shown[0], shown[2], shown[4]] as [
        Vector3,
        Vector3,
        Vector3,
      ]
      // 顶点深度相同：与成像平面平行。顶点间的像素距离为几何体中的距离乘以相对大小
      for (const [v, vertex] of shown.entries()) {
        expect(vertex.z).toBeCloseTo(tip.z, 6)
        expect(vertex.distanceTo(tip)).toBeCloseTo(
          (pixels[v] as Vector3).distanceTo(pixels[0] as Vector3) * size,
          2,
        )
      }
      // 尖端沿路径在屏幕上的方向
      const data = mesh === travelArrows ? target.data.travelArrows : target.data.processArrows
      const at = new Vector3().fromArray(data.positions, i * 3)
      const ahead = at
        .clone()
        .addScaledVector(new Vector3().fromArray(data.directions, i * 3), 1e-3)
      const path = toScreen(ahead, camera).sub(toScreen(at, camera)).setZ(0).normalize()
      const pointing = tip.clone().sub(upperEnd.clone().add(lowerEnd).multiplyScalar(0.5))
      expect(pointing.setZ(0).normalize().dot(path)).toBeCloseTo(1, 6)
    }

    // 斜看路径，各箭头离相机远近不同；再拉远到 3 倍
    for (const scale of [1, 3]) {
      const camera = cameraLooking(plan, new Vector3(0.2, -0.6, 0.5).multiplyScalar(scale))
      plan.fitArrows(camera, HEIGHT)
      for (const i of [0, 4]) {
        check(plan, processArrows, i, camera, 1)
        check(plan, travelArrows, i, camera, TRAVEL_ARROW_SCALE)
      }
    }

    const sparse = build(0.08)
    const camera = cameraLooking(sparse, new Vector3(0.2, -0.6, 0.5))
    sparse.fitArrows(camera, HEIGHT)
    expect(child<InstancedMesh>(sparse, 'process-arrows').count).toBe(1)
    check(sparse, child<InstancedMesh>(sparse, 'process-arrows'), 0, camera, 1)
  })

  it('箭头沿各自的视线朝相机前移 ARROW_LIFT_PX 像素对应的距离，屏幕上的位置不变', () => {
    const plan = build()
    const arrows = child<InstancedMesh>(plan, 'process-arrows')
    const camera = cameraLooking(plan, new Vector3(0.6, -0.6, 0.48))
    plan.fitArrows(camera, HEIGHT)
    const view = camera.getWorldDirection(new Vector3())

    for (const i of [0, 4]) {
      const original = arrowPosition(plan, i)
      const shown = new Vector3().setFromMatrixPosition(instanceMatrix(arrows, i))
      // 实例矩阵为单精度：方向比较到 1e-5 弧度，距离到微米，像素坐标到千分之一像素
      const toCamera = camera.position.clone().sub(original).normalize()
      const moved = shown.clone().sub(original)
      expect(moved.clone().normalize().cross(toCamera).length()).toBeCloseTo(0, 5)
      expect(moved.dot(toCamera)).toBeGreaterThan(0)
      const depth = (v: Vector3) => v.clone().sub(camera.position).dot(view)
      expect(depth(original) - depth(shown)).toBeCloseTo(ARROW_LIFT_PX * UNIT * depth(original), 6)
      const screen = (v: Vector3) => toScreen(v, camera).toArray().slice(0, 2)
      expect(screen(shown)).toEqual(screen(original).map((v) => expect.closeTo(v, 3)))
    }
  })

  it('调用 fitArrows 之前不显示箭头；路径正对相机、在屏幕上看不出方向时不显示', () => {
    const plan = build()
    const arrows = child<InstancedMesh>(plan, 'process-arrows')
    const sizes = () =>
      [0, 1, 2, 3, 4].map((i) => new Vector3().setFromMatrixScale(instanceMatrix(arrows, i)).x)
    expect(sizes()).toEqual([0, 0, 0, 0, 0])

    // 相机在路径的延长线上，沿路径方向看
    const camera = new PerspectiveCamera(38, WIDTH / HEIGHT, 0.01, 50)
    camera.position.set(0, 0.05, 0.1)
    camera.lookAt(1, 0.05, 0.1)
    plan.fitArrows(camera, HEIGHT)
    expect(sizes()).toEqual([0, 0, 0, 0, 0])

    // 从侧面斜看：都显示
    camera.position.set(0, -0.1, 0.1)
    camera.lookAt(plan.sphere.center)
    plan.fitArrows(camera, HEIGHT)
    for (const size of sizes()) expect(size).toBeGreaterThan(0)
  })

  it('相机和画布高度都没变时不重算箭头', () => {
    const plan = build()
    const arrows = child<InstancedMesh>(plan, 'process-arrows')
    const camera = cameraLooking(plan, new Vector3(0.6, -0.6, 0.48))
    plan.fitArrows(camera, HEIGHT)
    const version = arrows.instanceMatrix.version
    plan.fitArrows(camera, HEIGHT)
    expect(arrows.instanceMatrix.version).toBe(version)

    plan.fitArrows(camera, HEIGHT + 1)
    expect(arrows.instanceMatrix.version).toBe(version + 1)
    camera.position.x += 0.01
    plan.fitArrows(camera, HEIGHT + 1)
    expect(arrows.instanceMatrix.version).toBe(version + 2)
    camera.fov = 40
    plan.fitArrows(camera, HEIGHT + 1)
    expect(arrows.instanceMatrix.version).toBe(version + 3)
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

  it('失败路径：红色实线，线宽 3 像素，没有箭头，不参与进度着色；没有时不绘制', () => {
    expect(child<LineSegments2>(build(), 'failed').visible).toBe(false)
    const plan = buildWithFailed()
    const failed = child<LineSegments2>(plan, 'failed')
    expect(failed.visible).toBe(true)
    expect(failed.material).toBe(PATH_MATERIALS.failed)
    expect(PATH_MATERIALS.failed.color.getHex()).toBe(0xd93025)
    expect(PATH_MATERIALS.failed.linewidth).toBe(3)
    expect(PATH_MATERIALS.failed.dashed).toBe(false)
    expect(SCREEN_LINE_MATERIALS).toContain(PATH_MATERIALS.failed)
    // 3 段线：第一段路径 2 段，第二段 1 段
    expect(failed.geometry.getAttribute('instanceStart').count).toBe(3)
    // 箭头只在工艺段和空行程上
    expect(child<InstancedMesh>(plan, 'process-arrows').count).toBe(5)
    expect(child<InstancedMesh>(plan, 'travel-arrows').count).toBe(5)
    // 进度着色后失败路径不变
    plan.setProgress(10)
    expect(failed.material).toBe(PATH_MATERIALS.failed)
    expect(failed.geometry.getAttribute('instanceStart').count).toBe(3)
    // 包围球包括失败路径
    expect(plan.sphere.containsPoint(new Vector3(0.35, 0.14, 0.1))).toBe(true)
  })

  it('释放路径的几何体，不释放共享的材质和箭头的几何体', () => {
    const plan = buildWithFailed()
    const disposed: string[] = []
    for (const name of ['process', 'travel', 'failed', 'progress']) {
      child<LineSegments2>(plan, name).geometry.addEventListener('dispose', () =>
        disposed.push(name),
      )
    }
    expect(child<InstancedMesh>(plan, 'process-arrows').geometry).toBe(ARROW_GEOMETRY)
    let sharedDisposed = false
    const onShared = () => (sharedDisposed = true)
    PATH_MATERIALS.process.addEventListener('dispose', onShared)
    ARROW_MATERIALS.process.addEventListener('dispose', onShared)
    ARROW_GEOMETRY.addEventListener('dispose', onShared)
    plan.dispose()
    expect(disposed).toEqual(['process', 'travel', 'failed', 'progress'])
    expect(sharedDisposed).toBe(false)
  })
})

describe('chevronGeometry', () => {
  it('两臂是线宽为 stroke 的条带，在尖端斜接、不重叠；正面朝 +Z', () => {
    const [length, halfWidth, stroke] = [5, 5.5, 1.6]
    const geometry = chevronGeometry(length, halfWidth, stroke)
    const position = geometry.getAttribute('position')
    const vertex = (i: number) => new Vector3().fromBufferAttribute(position, i)
    expect(position.count).toBe(6)

    // 外尖角、内尖角和各臂末端的两个顶点到该臂中心线的距离都是半个线宽
    const tip = new Vector3(length / 2, 0, 0)
    const toArm = (i: number, end: Vector3) =>
      new Line3(tip, end).closestPointToPoint(vertex(i), false, new Vector3()).distanceTo(vertex(i))
    const upper = new Vector3(-length / 2, halfWidth, 0)
    const lower = new Vector3(-length / 2, -halfWidth, 0)
    for (const i of [0, 1, 2, 3]) expect(toArm(i, upper)).toBeCloseTo(stroke / 2, 5)
    for (const i of [0, 1, 4, 5]) expect(toArm(i, lower)).toBeCloseTo(stroke / 2, 5)

    // 三角形都是逆时针（朝 +Z），面积之和等于轮廓的面积：不重叠
    const index = Array.from(geometry.getIndex()?.array ?? [])
    expect(index.length).toBe(12)
    let total = 0
    for (let t = 0; t < index.length; t += 3) {
      const [a, b, c] = index.slice(t, t + 3).map(vertex) as [Vector3, Vector3, Vector3]
      const area = b.clone().sub(a).cross(c.clone().sub(a)).z / 2
      expect(area).toBeGreaterThan(0)
      total += area
    }
    const outline = [0, 2, 3, 1, 5, 4].map(vertex)
    const outlineArea = outline.reduce((sum, p, i) => {
      const q = outline[(i + 1) % outline.length] as Vector3
      return sum + (p.x * q.y - q.x * p.y) / 2
    }, 0)
    expect(total).toBeCloseTo(outlineArea, 9)
  })
})
