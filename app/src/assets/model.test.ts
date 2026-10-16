import { BufferAttribute, BufferGeometry } from 'three'
import { describe, expect, it } from 'vitest'
import { buildGlb, gridSurface, type TestSurface } from '../testing/glb.ts'
import { WORKPIECE_MATERIALS } from './materials.ts'
import { boundaryEdges, ModelError, parseModel } from './model.ts'

const MODEL = 'model_20261015T080000'

function glb(surfaces: TestSurface[], extras: object = { model_id: MODEL }) {
  return buildGlb(surfaces, extras)
}

/** 边界边的数量（每条 6 个数）。 */
const edgeCount = (segments: Float32Array) => segments.length / 6

describe('boundaryEdges', () => {
  it('网格表面的边界：n × n 个格子有 4n 条边界边', () => {
    for (const n of [1, 2, 5]) {
      const s = gridSurface('s', 0, 0, 0, n)
      const geometry = new BufferGeometry()
      geometry.setAttribute('position', new BufferAttribute(new Float32Array(s.positions), 3))
      geometry.setIndex(s.indices)
      expect(edgeCount(boundaryEdges(geometry)), `n=${n}`).toBe(4 * n)
    }
  })

  it('顶点没有共用（每个三角面各存一份）时先按位置合并', () => {
    const s = gridSurface('s', 0, 0, 0, 2)
    const soup: number[] = []
    for (const i of s.indices) soup.push(...s.positions.slice(i * 3, i * 3 + 3))
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(soup), 3))
    geometry.setIndex([...Array(soup.length / 3).keys()])
    expect(edgeCount(boundaryEdges(geometry))).toBe(8)
  })

  it('边界边的端点在表面的外框上', () => {
    const s = gridSurface('s', 0, 0, 0, 3)
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(s.positions), 3))
    geometry.setIndex(s.indices)
    const segments = boundaryEdges(geometry)
    for (let i = 0; i < segments.length; i += 3) {
      const [x, y] = [segments[i] as number, segments[i + 1] as number]
      const onEdge = [x, y].some((v) => Math.abs(v) < 1e-6 || Math.abs(v - 0.1) < 1e-6)
      expect(onEdge).toBe(true)
    }
  })
})

describe('parseModel（接口文档 10.2）', () => {
  const surfaces = () => [
    gridSurface('top_00', 0.3, 0, 0.1),
    gridSurface('top_01', 0.4, 0, 0.1),
    { ...gridSurface('wall_00', 0.3, 0.1, 0), selectable: false },
  ]

  it('建立表面索引，换成共享材质，计算包围盒和分界线', async () => {
    const model = await parseModel(glb(surfaces()), MODEL)
    expect([...model.surfaces.keys()]).toEqual(['top_00', 'top_01', 'wall_00'])
    expect([...model.surfaces.values()].map((s) => s.selectable)).toEqual([true, true, false])
    expect(model.group.children).toHaveLength(3)
    expect(model.triangles).toBe(24)
    for (const { mesh } of model.surfaces.values()) {
      expect(mesh.material).toBe(WORKPIECE_MATERIALS.normal)
    }
    expect(model.box.min.toArray().map((v) => +v.toFixed(3))).toEqual([0.3, 0, 0])
    expect(model.box.max.toArray().map((v) => +v.toFixed(3))).toEqual([0.5, 0.2, 0.1])
    expect(model.sphere.radius).toBeGreaterThan(0)
    // 每个 2 × 2 的表面 8 条边界边
    expect(model.boundaries.geometry.getAttribute('instanceStart').count).toBe(24)
  })

  it('表面节点的 surface_id 来自节点 extras', async () => {
    const model = await parseModel(glb(surfaces()), MODEL)
    for (const [id, surface] of model.surfaces) expect(surface.mesh.userData.surface_id).toBe(id)
  })

  it.each([
    ['model_id 与状态不一致', glb(surfaces(), { model_id: 'model_old' }), 'model_id'],
    ['场景没有 extras', glb(surfaces(), {}), 'model_id'],
    ['没有表面', glb([]), '没有表面'],
    ['多个 primitive', glb([{ ...gridSurface('a', 0, 0), primitives: 2 }]), '单 primitive'],
    ['缺少 surface_id', glb([{ ...gridSurface('a', 0, 0), id: undefined }]), 'surface_id'],
    ['surface_id 重复', glb([gridSurface('a', 0, 0), gridSurface('a', 0.2, 0)]), '重复'],
  ])('%s时拒绝', async (_, data, message) => {
    await expect(parseModel(data, MODEL)).rejects.toThrow(ModelError)
    await expect(parseModel(data, MODEL)).rejects.toThrow(message)
  })

  it('不是 GLB 时拒绝', async () => {
    await expect(parseModel(new TextEncoder().encode('<html>').buffer, MODEL)).rejects.toThrow(
      'GLB 解析失败',
    )
  })

  it('selectable 不是 true 时不可选', async () => {
    const data = new Uint8Array(glb([gridSurface('b', 0, 0)]))
    // 在 JSON 部分把 extras 中的 selectable 改为等长的字符串
    const from = new TextEncoder().encode('"selectable":true')
    const to = new TextEncoder().encode('"selectable":"1" ')
    const at = data.findIndex((_, i) => from.every((byte, k) => data[i + k] === byte))
    data.set(to, at)
    expect((await parseModel(data.buffer, MODEL)).surfaces.get('b')?.selectable).toBe(false)
  })

  it('dispose 释放几何体，不释放共享材质', async () => {
    const model = await parseModel(glb(surfaces()), MODEL)
    let disposed = 0
    for (const { mesh } of model.surfaces.values()) {
      mesh.geometry.addEventListener('dispose', () => (disposed += 1))
    }
    let materialDisposed = false
    WORKPIECE_MATERIALS.normal.addEventListener('dispose', () => (materialDisposed = true))
    model.dispose()
    expect(disposed).toBe(3)
    expect(materialDisposed).toBe(false)
  })
})
