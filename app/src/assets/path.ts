/**
 * TCP 路径的三维对象（需求 6.5；前端UI设计第 5 节；架构设计 5.7）：工艺段、空行程段、进度叠加线和方向箭头。
 * 由规划解析的结果在主线程创建，每类线段只有一个对象；进度通过绘制数量和箭头的实例颜色显示，不重建几何。
 */
import { Box3, Color, Group, InstancedMesh, Matrix4, Quaternion, Sphere, Vector3 } from 'three'
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js'
import type { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js'
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js'
import { passedCount } from '../domain/interpolation.ts'
import { ARROW_GEOMETRY, ARROW_MATERIALS, PATH_COLORS, PATH_MATERIALS } from './materials.ts'
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
  /** 释放几何体。材质和箭头的几何体是共享的，不释放。 */
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

function arrows(data: Arrows, name: string, process: boolean): InstancedMesh {
  const count = data.times.length
  const mesh = new InstancedMesh(
    ARROW_GEOMETRY,
    process ? ARROW_MATERIALS.process : ARROW_MATERIALS.travel,
    count,
  )
  mesh.name = name
  const matrix = new Matrix4()
  const position = new Vector3()
  const direction = new Vector3()
  const rotation = new Quaternion()
  const scale = new Vector3(1, 1, 1)
  const blue = new Color(PATH_COLORS.process)
  for (let i = 0; i < count; i++) {
    position.fromArray(data.positions, i * 3)
    direction.fromArray(data.directions, i * 3)
    mesh.setMatrixAt(i, matrix.compose(position, rotation.setFromUnitVectors(UP, direction), scale))
    if (process) mesh.setColorAt(i, blue)
  }
  mesh.computeBoundingSphere()
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

  const processArrows = arrows(data.processArrows, 'process-arrows', true)
  const travelArrows = arrows(data.travelArrows, 'travel-arrows', false)

  const group = new Group()
  group.name = data.planId
  group.add(process, travel, progress, processArrows, travelArrows)
  group.traverse((object) => {
    object.updateMatrix()
    object.matrixAutoUpdate = false
  })

  const blue = new Color(PATH_COLORS.process)
  const green = new Color(PATH_COLORS.progress)
  const arrowTimes = data.processArrows.times
  let greenArrows = 0

  const box = new Box3(new Vector3(...data.min), new Vector3(...data.max))
  return {
    id: data.planId,
    data,
    group,
    start: new Vector3(...data.start),
    end: new Vector3(...data.end),
    sphere: box.getBoundingSphere(new Sphere()),
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
    dispose: () => {
      process.geometry.dispose()
      travel.geometry.dispose()
      progressGeometry.dispose()
      processArrows.dispose()
      travelArrows.dispose()
    },
  }
}
