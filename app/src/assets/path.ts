/**
 * TCP 路径的三维对象（需求 6.5；前端UI设计第 5 节；架构设计 5.7）：工艺段、空行程段、进度叠加线和方向箭头。
 * 由规划解析的结果在主线程创建，每类线段只有一个对象；进度通过绘制数量和箭头的实例颜色显示，不重建几何。
 */
import {
  Box3,
  Color,
  DynamicDrawUsage,
  Group,
  InstancedMesh,
  type Material,
  type PerspectiveCamera,
  Sphere,
  Vector3,
} from 'three'
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js'
import type { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js'
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js'
import { passedCount } from '../domain/interpolation.ts'
import {
  ARROW_COLORS,
  ARROW_GEOMETRY,
  ARROW_LIFT_PX,
  ARROW_MATERIALS,
  PATH_MATERIALS,
  TRAVEL_ARROW_SCALE,
} from './materials.ts'
import type { Arrows, PlanData } from './plan.ts'

export interface LoadedPlan {
  id: string
  data: PlanData
  /** 全部线段和箭头，坐标即 base_link */
  group: Group
  start: Vector3
  end: Vector3
  /** 路径点的包围球 */
  sphere: Sphere
  /** 按时间显示进度：已走过的工艺段叠加绿线，对应的箭头变绿；null 表示不显示进度。 */
  setProgress(t: number | null): void
  /**
   * 按相机摆放箭头，场景每次绘制前调用（前端UI设计第 5 节）；调用之前箭头不显示。heightPx 为画布高度，CSS 像素。
   * 相机和画布高度都没变时直接返回。
   * - 箭头与成像平面平行，尖端沿路径在屏幕上的方向；路径几乎正对相机、在屏幕上看不出方向时不显示。
   * - 大小以屏幕像素计：按每个箭头处的深度把像素换算成米，远近不同的箭头在屏幕上一样大。
   * - 每个箭头沿自己的视线朝相机前移 ARROW_LIFT_PX 像素对应的距离。透视投影下屏幕上的位置和大小不变，
   *   只是离相机更近：路径点在工件表面上时，斜看表面箭头也不会被表面挡住一部分。
   */
  fitArrows(camera: PerspectiveCamera, heightPx: number): void
  /** 释放路径的几何体。材质和箭头的几何体是共享的，不释放。 */
  dispose(): void
}

function lines(positions: Float32Array, name: string, material: LineMaterial): LineSegments2 {
  const geometry = new LineSegmentsGeometry()
  geometry.setPositions(positions)
  const line = new LineSegments2(geometry, material)
  line.name = name
  return line
}

/** 一组箭头：共享的几何体（单位为像素），实例矩阵由 fitArrows 按相机重算；size 为相对大小。 */
interface ArrowSet {
  mesh: InstancedMesh
  data: Arrows
  size: number
}

/**
 * 实例矩阵每次绘制前重算，包围球算一次就过时了，不做视锥剔除；箭头都在路径附近，剔除也省不了什么。
 * 实例矩阵先置零，调用 fitArrows 之前不显示。
 */
function arrows(
  data: Arrows,
  name: string,
  material: Material,
  size: number,
  color: Color | null,
): ArrowSet {
  const count = data.times.length
  const mesh = new InstancedMesh(ARROW_GEOMETRY, material, count)
  mesh.name = name
  mesh.frustumCulled = false
  mesh.instanceMatrix.setUsage(DynamicDrawUsage)
  mesh.instanceMatrix.array.fill(0)
  if (color) for (let i = 0; i < count; i++) mesh.setColorAt(i, color)
  return { mesh, data, size }
}

/** 视线与路径的夹角小于约 3°（正弦小于此值）时，路径在屏幕上看不出方向，不显示箭头。 */
const MIN_SINE = 0.05

/**
 * 按相机重算一组箭头的实例矩阵（见 LoadedPlan.fitArrows）。c 为相机位置，f 为视线方向（单位向量），
 * unit 为沿视线 1 米深处 1 像素对应的长度，k 为以相机为中心的缩放系数。
 */
function fitArrowSet(
  { mesh, data, size }: ArrowSet,
  c: Vector3,
  f: Vector3,
  unit: number,
  k: number,
): void {
  const m = mesh.instanceMatrix.array
  const p = data.positions
  const d = data.directions
  for (let i = 0, o = 0, b = 0; i < data.times.length; i++, o += 3, b += 16) {
    // 相机到箭头 v，深度 z
    const vx = (p[o] as number) - c.x
    const vy = (p[o + 1] as number) - c.y
    const vz = (p[o + 2] as number) - c.z
    const z = vx * f.x + vy * f.y + vz * f.z
    // 路径方向 t 在屏幕上的方向（成像平面内）：a = z·t − (t·f)·v
    const tx = d[o] as number
    const ty = d[o + 1] as number
    const tz = d[o + 2] as number
    const tf = tx * f.x + ty * f.y + tz * f.z
    let ax = z * tx - tf * vx
    let ay = z * ty - tf * vy
    let az = z * tz - tf * vz
    const length = Math.hypot(ax, ay, az)
    // 前移后的位置：以相机为中心缩放 k 倍，深度变为 k·z
    m[b + 12] = c.x + vx * k
    m[b + 13] = c.y + vy * k
    m[b + 14] = c.z + vz * k
    m[b + 15] = 1
    if (!(z > 0) || length < MIN_SINE * Math.hypot(vx, vy, vz)) {
      m.fill(0, b, b + 12)
      continue
    }
    // 前移后的深度 k·z 处 1 像素对应的长度，乘以相对大小
    const scale = unit * k * z * size
    ax *= scale / length
    ay *= scale / length
    az *= scale / length
    // 基向量：X 沿屏幕上的路径方向，Y = X × f，Z = −f 朝向相机；长度都是 scale
    m[b] = ax
    m[b + 1] = ay
    m[b + 2] = az
    m[b + 3] = 0
    m[b + 4] = ay * f.z - az * f.y
    m[b + 5] = az * f.x - ax * f.z
    m[b + 6] = ax * f.y - ay * f.x
    m[b + 7] = 0
    m[b + 8] = -f.x * scale
    m[b + 9] = -f.y * scale
    m[b + 10] = -f.z * scale
    m[b + 11] = 0
  }
  mesh.instanceMatrix.needsUpdate = true
}

export function buildPath(data: PlanData): LoadedPlan {
  const process = lines(data.process, 'process', PATH_MATERIALS.process)
  const travel = lines(data.travel, 'travel', PATH_MATERIALS.travel)
  // 虚线按沿线距离分段
  travel.computeLineDistances()

  // 进度线与工艺段共用顶点数据，只改绘制数量
  const progressGeometry = new LineSegmentsGeometry()
  for (const name of ['instanceStart', 'instanceEnd']) {
    progressGeometry.setAttribute(name, process.geometry.getAttribute(name))
  }
  progressGeometry.boundingBox = process.geometry.boundingBox?.clone() ?? null
  progressGeometry.boundingSphere = process.geometry.boundingSphere?.clone() ?? null
  const progress = new LineSegments2(progressGeometry, PATH_MATERIALS.progress)
  progress.name = 'progress'
  progress.renderOrder = 2
  progress.visible = false

  const blue = new Color(ARROW_COLORS.process)
  const arrowSets = [
    arrows(data.processArrows, 'process-arrows', ARROW_MATERIALS.process, 1, blue),
    arrows(data.travelArrows, 'travel-arrows', ARROW_MATERIALS.travel, TRAVEL_ARROW_SCALE, null),
  ] as const
  const processArrows = arrowSets[0].mesh
  const travelArrows = arrowSets[1].mesh

  const group = new Group()
  group.name = data.planId
  group.add(process, travel, progress, processArrows, travelArrows)
  group.traverse((object) => {
    object.updateMatrix()
    object.matrixAutoUpdate = false
  })

  const green = new Color(ARROW_COLORS.progress)
  const arrowTimes = data.processArrows.times
  let greenArrows = 0

  const sphere = new Box3(new Vector3(...data.min), new Vector3(...data.max)).getBoundingSphere(
    new Sphere(),
  )
  // 上次调整箭头时的相机矩阵、画布高度、视场角和缩放
  const fitted = new Float64Array(19).fill(Number.NaN)
  const cameraPosition = new Vector3()
  const view = new Vector3()
  return {
    id: data.planId,
    data,
    group,
    start: new Vector3(...data.start),
    end: new Vector3(...data.end),
    sphere,
    setProgress: (t) => {
      const segments = t === null ? 0 : passedCount(data.processEnds, t)
      progressGeometry.instanceCount = segments
      progress.visible = segments > 0
      // 箭头按时间排列，只更新变化的部分
      const count = t === null ? 0 : passedCount(arrowTimes, t)
      if (count === greenArrows) return
      const [from, to, color] =
        count > greenArrows ? [greenArrows, count, green] : [count, greenArrows, blue]
      for (let i = from; i < to; i++) processArrows.setColorAt(i, color)
      if (processArrows.instanceColor) processArrows.instanceColor.needsUpdate = true
      greenArrows = count
    },
    fitArrows: (camera, heightPx) => {
      // 画布还没有尺寸时不调整
      if (!(heightPx > 0)) return
      camera.updateWorldMatrix(true, false)
      const e = camera.matrixWorld.elements
      let same = heightPx === fitted[16] && camera.fov === fitted[17] && camera.zoom === fitted[18]
      for (let i = 0; same && i < 16; i++) same = e[i] === fitted[i]
      if (same) return
      fitted.set(e)
      fitted.set([heightPx, camera.fov, camera.zoom], 16)

      cameraPosition.setFromMatrixPosition(camera.matrixWorld)
      camera.getWorldDirection(view)
      // 沿视线 1 米深处 1 像素对应的长度
      const unit = (2 * Math.tan((camera.fov * Math.PI) / 360)) / (camera.zoom * heightPx)
      // 以相机为中心缩放 k 倍：x → C + k·(x − C)，深度 z 处前移 (1 − k)·z = ARROW_LIFT_PX 像素
      const k = 1 - ARROW_LIFT_PX * unit
      for (const set of arrowSets) fitArrowSet(set, cameraPosition, view, unit, k)
    },
    dispose: () => {
      process.geometry.dispose()
      travel.geometry.dispose()
      progressGeometry.dispose()
      processArrows.dispose()
      travelArrows.dispose()
    },
  }
}
