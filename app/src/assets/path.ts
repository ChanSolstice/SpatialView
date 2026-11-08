/**
 * TCP 路径的三维对象（需求 6.5；前端UI设计第 5 节；架构设计 5.7）：工艺段、空行程段、进度叠加线和方向箭头。
 * 由规划解析的结果在主线程创建，每类线段只有一个对象；进度通过绘制数量和箭头的实例颜色显示，不重建几何。
 */
import {
  Box3,
  type BufferAttribute,
  type BufferGeometry,
  Color,
  Group,
  InstancedMesh,
  type Material,
  Matrix4,
  type PerspectiveCamera,
  Quaternion,
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
   * 按相机调整箭头，场景每次绘制前调用（前端UI设计第 5 节）；调用之前箭头不显示。heightPx 为画布高度，CSS 像素。
   * - 大小以屏幕像素计：按路径中心处 1 像素对应的长度缩放箭头的几何体。
   * - 以相机为中心把箭头整体缩小一点，每个箭头沿自己的视线朝相机前移半个箭头长。透视投影下屏幕上的位置和
   *   大小不变，只是离相机更近：路径点在工件表面上时，箭头不会有一半被表面挡住。
   */
  fitArrows(camera: PerspectiveCamera, heightPx: number): void
  /** 释放几何体。材质是共享的，不释放。 */
  dispose(): void
}

function lines(positions: Float32Array, name: string, material: LineMaterial): LineSegments2 {
  const geometry = new LineSegmentsGeometry()
  geometry.setPositions(positions)
  const line = new LineSegments2(geometry, material)
  line.name = name
  return line
}

const UP = new Vector3(0, 1, 0)

/**
 * 一组箭头。geometry 的单位随 fitArrows 变化，实例矩阵只含位置、方向和相对大小 size，缩放时不用改写。
 * 包围球按实例矩阵算不出实际大小，不做视锥剔除；箭头都在路径附近，剔除也省不了什么。
 */
function arrows(
  data: Arrows,
  name: string,
  geometry: BufferGeometry,
  material: Material,
  size: number,
  color: Color | null,
): InstancedMesh {
  const count = data.times.length
  const mesh = new InstancedMesh(geometry, material, count)
  mesh.name = name
  mesh.frustumCulled = false
  const matrix = new Matrix4()
  const position = new Vector3()
  const direction = new Vector3()
  const rotation = new Quaternion()
  const scale = new Vector3().setScalar(size)
  for (let i = 0; i < count; i++) {
    position.fromArray(data.positions, i * 3)
    direction.fromArray(data.directions, i * 3)
    mesh.setMatrixAt(i, matrix.compose(position, rotation.setFromUnitVectors(UP, direction), scale))
    if (color) mesh.setColorAt(i, color)
  }
  return mesh
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

  // 箭头的几何体每个规划一份，两组共用：顶点按像素保存一份，fitArrows 时乘以每像素的米数写回。
  // 只有几十个顶点，缩放时不改写实例矩阵
  const arrowGeometry = ARROW_GEOMETRY.clone()
  const arrowPositions = arrowGeometry.getAttribute('position') as BufferAttribute
  const pixelPositions = Float32Array.from(arrowPositions.array)
  arrowPositions.array.fill(0)
  let pixelSize = 0
  const blue = new Color(ARROW_COLORS.process)
  const processArrows = arrows(
    data.processArrows,
    'process-arrows',
    arrowGeometry,
    ARROW_MATERIALS.process,
    1,
    blue,
  )
  const travelArrows = arrows(
    data.travelArrows,
    'travel-arrows',
    arrowGeometry,
    ARROW_MATERIALS.travel,
    TRAVEL_ARROW_SCALE,
    null,
  )

  const group = new Group()
  group.name = data.planId
  group.add(process, travel, progress, processArrows, travelArrows)
  group.traverse((object) => {
    object.updateMatrix()
    object.matrixAutoUpdate = false
  })

  const green = new Color(ARROW_COLORS.progress)
  const lift = new Matrix4()
  const arrowTimes = data.processArrows.times
  let greenArrows = 0

  const sphere = new Box3(new Vector3(...data.min), new Vector3(...data.max)).getBoundingSphere(
    new Sphere(),
  )
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
      // 距相机 1 米处 1 像素对应的长度
      const unit = (2 * Math.tan((camera.fov * Math.PI) / 360)) / heightPx
      const meters = unit * camera.position.distanceTo(sphere.center)
      if (meters !== pixelSize) {
        pixelSize = meters
        const array = arrowPositions.array
        for (let i = 0; i < array.length; i++) array[i] = (pixelPositions[i] as number) * meters
        arrowPositions.needsUpdate = true
      }
      // 以相机位置 C 为中心缩放 k 倍：x → k·x + (1 − k)·C。路径中心处前移 (1 − k)·距离 = 半个箭头长
      const k = 1 - (ARROW_GEOMETRY.parameters.height / 2) * unit
      const c = camera.position
      lift.makeScale(k, k, k).setPosition(c.x * (1 - k), c.y * (1 - k), c.z * (1 - k))
      for (const mesh of [processArrows, travelArrows]) {
        mesh.matrix.copy(lift)
        mesh.matrixWorldNeedsUpdate = true
      }
    },
    dispose: () => {
      process.geometry.dispose()
      travel.geometry.dispose()
      progressGeometry.dispose()
      arrowGeometry.dispose()
      processArrows.dispose()
      travelArrows.dispose()
    },
  }
}
