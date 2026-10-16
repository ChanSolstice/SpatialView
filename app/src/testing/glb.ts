/** 测试用：按接口文档 10.2 的结构生成小的 GLB，也可以故意违反要求。不进入打包产物。 */

export interface TestSurface {
  /** 节点 extras 中的 surface_id；为 undefined 时不写 */
  id?: string
  selectable?: boolean
  /** 顶点坐标，每 3 个数一个顶点 */
  positions: number[]
  indices: number[]
  /** mesh 中 primitive 的个数，默认 1 */
  primitives?: number
}

/** 一个 0.1 米见方、由 n × n 个格子组成的平面表面，左下角在 (x, y, z)。 */
export function gridSurface(id: string, x: number, y: number, z = 0, n = 2): TestSurface {
  const positions: number[] = []
  const indices: number[] = []
  const step = 0.1 / n
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= n; j++) positions.push(x + i * step, y + j * step, z)
  }
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const a = i * (n + 1) + j
      const b = a + n + 1
      indices.push(a, b, a + 1, b, b + 1, a + 1)
    }
  }
  return { id, selectable: true, positions, indices }
}

export function buildGlb(surfaces: TestSurface[], sceneExtras: object): ArrayBuffer {
  const chunks: Uint8Array[] = []
  let byteLength = 0
  const bufferViews: object[] = []
  const accessors: object[] = []
  const add = (data: Float32Array | Uint32Array, accessor: object) => {
    bufferViews.push({ buffer: 0, byteOffset: byteLength, byteLength: data.byteLength })
    chunks.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
    byteLength += data.byteLength
    accessors.push({ bufferView: bufferViews.length - 1, byteOffset: 0, ...accessor })
    return accessors.length - 1
  }

  const meshes = surfaces.map((surface) => {
    const positions = new Float32Array(surface.positions)
    const min = [0, 1, 2].map((k) => Math.min(...surface.positions.filter((_, i) => i % 3 === k)))
    const max = [0, 1, 2].map((k) => Math.max(...surface.positions.filter((_, i) => i % 3 === k)))
    const position = add(positions, {
      componentType: 5126,
      count: positions.length / 3,
      type: 'VEC3',
      min,
      max,
    })
    const normal = add(
      new Float32Array(positions.length).map((_, i) => (i % 3 === 2 ? 1 : 0)),
      {
        componentType: 5126,
        count: positions.length / 3,
        type: 'VEC3',
      },
    )
    const indices = add(new Uint32Array(surface.indices), {
      componentType: 5125,
      count: surface.indices.length,
      type: 'SCALAR',
    })
    const primitive = { attributes: { POSITION: position, NORMAL: normal }, indices, mode: 4 }
    return { primitives: Array.from({ length: surface.primitives ?? 1 }, () => primitive) }
  })

  const json = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: surfaces.map((_, i) => i), extras: sceneExtras }],
    nodes: surfaces.map((surface, i) => ({
      name: surface.id ?? `node_${i}`,
      mesh: i,
      extras: {
        ...(surface.id !== undefined ? { surface_id: surface.id } : {}),
        selectable: surface.selectable ?? true,
      },
    })),
    meshes,
    accessors,
    bufferViews,
    buffers: [{ byteLength }],
  }

  const pad = (length: number) => (4 - (length % 4)) % 4
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json))
  const jsonLength = jsonBytes.length + pad(jsonBytes.length)
  const binLength = byteLength + pad(byteLength)
  const total = 12 + 8 + jsonLength + 8 + binLength
  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)
  view.setUint32(0, 0x46546c67, true) // glTF
  view.setUint32(4, 2, true)
  view.setUint32(8, total, true)
  view.setUint32(12, jsonLength, true)
  view.setUint32(16, 0x4e4f534a, true) // JSON
  out.set(jsonBytes, 20)
  out.fill(0x20, 20 + jsonBytes.length, 20 + jsonLength)
  const bin = 20 + jsonLength
  view.setUint32(bin, binLength, true)
  view.setUint32(bin + 4, 0x004e4942, true) // BIN
  let at = bin + 8
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.length
  }
  return out.buffer
}
