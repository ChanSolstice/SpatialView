/**
 * 工件模型的解析、校验和释放（需求 6.3、6.4；接口文档第 10 节；架构设计 5.6）。
 * GLB 中每个表面是一个单 primitive 的节点，GLTFLoader 把节点的 extras 放进 userData。
 */
import { Box3, BufferGeometry, Group, Mesh, Sphere, type Material } from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js'
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { BOUNDARY_MATERIAL, WORKPIECE_MATERIALS } from './materials.ts'

export class ModelError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ModelError'
  }
}

export interface Surface {
  id: string
  selectable: boolean
  mesh: Mesh
}

export interface LoadedModel {
  id: string
  /** 全部表面节点，坐标即 base_link。 */
  group: Group
  surfaces: ReadonlyMap<string, Surface>
  /** 各表面的边界，只在选面模式显示（需求 6.4）。 */
  boundaries: LineSegments2
  /** 指定表面的边界边，每条边 6 个数，用于勾出没有生成路径的表面（需求 6.4）；模型中没有的表面忽略。 */
  outline(ids: Iterable<string>): Float32Array
  box: Box3
  sphere: Sphere
  triangles: number
  /** 释放几何体和拾取加速结构。材质是共享的，不释放。 */
  dispose(): void
}

/**
 * 一个三角网格的边界边（只属于一个三角面的边），每条边 6 个数（两个端点）。
 * 表面内的顶点没有共用时（每个三角面各存一份顶点），先按位置合并，否则每条边都会被当成边界。
 */
export function boundaryEdges(geometry: BufferGeometry): Float32Array {
  const position = geometry.getAttribute('position')
  let source = geometry
  if (!geometry.index || position.count >= geometry.index.count) {
    const positions = new BufferGeometry()
    positions.setAttribute('position', position)
    if (geometry.index) positions.setIndex(geometry.index)
    source = mergeVertices(positions, 1e-6)
  }
  const index = source.index
  if (!index) return new Float32Array(0)
  const ids = index.array
  const count = source.getAttribute('position').count
  const xyz = source.getAttribute('position').array

  // 每条边编码为"小顶点号 × 顶点数 + 大顶点号"，排序后只出现一次的就是边界
  const keys = new Float64Array(ids.length)
  for (let t = 0; t + 2 < ids.length; t += 3) {
    const a = ids[t] as number
    const b = ids[t + 1] as number
    const c = ids[t + 2] as number
    keys[t] = a < b ? a * count + b : b * count + a
    keys[t + 1] = b < c ? b * count + c : c * count + b
    keys[t + 2] = c < a ? c * count + a : a * count + c
  }
  keys.sort()
  const out: number[] = []
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i] as number
    if (key === keys[i - 1] || key === keys[i + 1]) continue
    const lo = Math.floor(key / count)
    const hi = key - lo * count
    for (const v of [lo, hi])
      out.push(xyz[v * 3] as number, xyz[v * 3 + 1] as number, xyz[v * 3 + 2] as number)
  }
  if (source !== geometry) source.dispose()
  return new Float32Array(out)
}

/** 解析 GLB 并按接口文档 10.2 校验。expectedId 为 SystemState 中的 model_id。 */
export async function parseModel(data: ArrayBuffer, expectedId: string): Promise<LoadedModel> {
  let scene: Group
  try {
    scene = (await new GLTFLoader().parseAsync(data, '')).scene
  } catch (error) {
    throw new ModelError(`GLB 解析失败：${error instanceof Error ? error.message : String(error)}`)
  }
  // GLB 中没有材质，GLTFLoader 给每个 primitive 一个默认材质；统一换成共享材质，默认材质释放
  const loaderMaterials = new Set<Material>()
  scene.traverse((object) => {
    if (object instanceof Mesh) loaderMaterials.add(object.material as Material)
  })
  const invalid = (message: string) => {
    scene.traverse((object) => {
      if (object instanceof Mesh) object.geometry.dispose()
    })
    for (const material of loaderMaterials) material.dispose()
    return new ModelError(message)
  }

  const modelId: unknown = scene.userData.model_id
  if (modelId !== expectedId) {
    throw invalid(`模型文件的 model_id 为 ${String(modelId)}，应为 ${expectedId}`)
  }
  const children = [...scene.children]
  if (children.length === 0) throw invalid('模型中没有表面')

  const surfaces = new Map<string, Surface>()
  let triangles = 0
  for (const child of children) {
    const where = child.name ? `节点 ${child.name}` : '未命名的节点'
    // 多个 primitive 的 mesh 会被解析为包含多个 Mesh 的 Group，点选时读不到节点信息
    if (!(child instanceof Mesh) || child.children.length > 0) {
      throw invalid(`${where}不是单 primitive 的 mesh`)
    }
    const id: unknown = child.userData.surface_id
    if (typeof id !== 'string' || id === '') throw invalid(`${where}缺少 surface_id`)
    if (surfaces.has(id)) throw invalid(`surface_id ${id} 重复`)
    const geometry: BufferGeometry = child.geometry
    if (!geometry.getAttribute('position') || !geometry.index) {
      throw invalid(`表面 ${id} 缺少顶点坐标或索引`)
    }
    triangles += geometry.index.count / 3
    surfaces.set(id, { id, selectable: child.userData.selectable === true, mesh: child })
  }
  for (const material of loaderMaterials) material.dispose()

  const group = new Group()
  group.name = expectedId
  const segments: Float32Array[] = []
  for (const { mesh } of surfaces.values()) {
    mesh.material = WORKPIECE_MATERIALS.normal
    // 节点不设置变换（接口文档 10.2）；不再逐帧更新矩阵
    mesh.updateMatrix()
    mesh.matrixAutoUpdate = false
    mesh.geometry.computeBoundingBox()
    mesh.geometry.computeBoundingSphere()
    group.add(mesh)
    segments.push(boundaryEdges(mesh.geometry))
  }

  const merged = new Float32Array(segments.reduce((sum, s) => sum + s.length, 0))
  // 各表面的边界边在 merged 中的起止位置，按表面顺序与 segments 对应
  const ranges = new Map<string, [number, number]>()
  let offset = 0
  let i = 0
  for (const id of surfaces.keys()) {
    const s = segments[i++] as Float32Array
    merged.set(s, offset)
    ranges.set(id, [offset, offset + s.length])
    offset += s.length
  }
  const lineGeometry = new LineSegmentsGeometry()
  lineGeometry.setPositions(merged)
  const boundaries = new LineSegments2(lineGeometry, BOUNDARY_MATERIAL)
  boundaries.name = 'boundaries'

  const box = new Box3().setFromObject(group)
  const sphere = box.getBoundingSphere(new Sphere())

  return {
    id: expectedId,
    group,
    surfaces,
    boundaries,
    outline: (ids) => {
      const parts = [...new Set(ids)].flatMap((id) => {
        const range = ranges.get(id)
        return range ? [merged.subarray(range[0], range[1])] : []
      })
      const out = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0))
      let o = 0
      for (const part of parts) {
        out.set(part, o)
        o += part.length
      }
      return out
    },
    box,
    sphere,
    triangles,
    dispose: () => {
      for (const { mesh } of surfaces.values()) {
        const geometry = mesh.geometry as BufferGeometry & { disposeBoundsTree?: () => void }
        // drei 的 Bvh 卸载时也会释放；这里确保替换模型时一定释放
        if ('boundsTree' in geometry && geometry.boundsTree) geometry.disposeBoundsTree?.()
        geometry.dispose()
      }
      lineGeometry.dispose()
    },
  }
}
