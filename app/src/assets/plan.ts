/**
 * 规划文件的解析和校验（接口文档第 11 节；架构设计 5.6），生成路径绘制和轨迹动画需要的类型化数组。
 * 在 Web Worker 中运行（plan.worker.ts）；不引用 three.js，测试中可以在主线程直接调用。
 */

export class PlanError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PlanError'
  }
}

export type Vec3 = [number, number, number]

/** 沿路径按固定间距放置的方向箭头（需求 6.5）。 */
export interface Arrows {
  /** 每个箭头 3 个数 */
  positions: Float32Array
  /** 单位方向向量，每个箭头 3 个数 */
  directions: Float32Array
  /** 箭头所在位置的时间，非递减；工艺段的箭头按它随进度变绿 */
  times: Float64Array
}

/**
 * 规划文件中的表面集合（接口文档 11.1、11.2）：有效选择和规划范围。规划范围包括有效选择和连续扩展进来的表面，
 * 也包括 surfaceIds 和失败路径所在的表面。
 */
export interface PlanScope {
  /** 有效选择（selected_surface_ids）：操作员的选择，包括整个表面都没有生成轨迹的 */
  selected: string[]
  /** 规划范围（planning_scope_surface_ids） */
  planning: string[]
}

export interface PlanData {
  planId: string
  modelId: string
  /** 有有效轨迹的表面（surface_ids），与 plan_surface_ids 一致 */
  surfaceIds: string[]
  /** 表面集合；旧服务端的规划文件没有这两个字段时为 null（接口文档 11.2） */
  scope: PlanScope | null
  duration: number
  jointNames: string[]
  /** 关节轨迹各点的时间，严格递增 */
  jointTimes: Float64Array
  /** 各点的关节值，按点依次存放，每点 jointNames.length 个 */
  jointPositions: Float32Array
  /** 工艺段：两端都处于工艺段（process_on）的相邻两点连成的线段，每段 6 个数 */
  process: Float32Array
  /** 各工艺段的结束时间，非递减；用于进度着色 */
  processEnds: Float64Array
  /** 空行程段，每段 6 个数 */
  travel: Float32Array
  /** 失败路径（failed_paths）：每段路径中相邻两点连成的线段，每段 6 个数；不执行，不参与进度着色 */
  failed: Float32Array
  processArrows: Arrows
  travelArrows: Arrows
  start: Vec3
  end: Vec3
  /** TCP 路径点和失败路径点的包围盒 */
  min: Vec3
  max: Vec3
}

/** PlanData 中的缓冲区，Worker 以可转移对象交回主线程，不复制数据。 */
export function planBuffers(data: PlanData): ArrayBuffer[] {
  const arrays = [
    data.jointTimes,
    data.jointPositions,
    data.process,
    data.processEnds,
    data.travel,
    data.failed,
    data.processArrows.positions,
    data.processArrows.directions,
    data.processArrows.times,
    data.travelArrows.positions,
    data.travelArrows.directions,
    data.travelArrows.times,
  ]
  return arrays.map((array) => array.buffer as ArrayBuffer)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function points(owner: unknown, what: string): unknown[] {
  const list = isRecord(owner) ? owner.points : undefined
  if (!Array.isArray(list) || list.length === 0) throw new PlanError(`规划文件缺少${what}`)
  return list
}

/** 逐点读取时间，检查严格递增（接口文档 11.2）。 */
function readTimes(list: unknown[], what: string): Float64Array {
  const times = new Float64Array(list.length)
  list.forEach((point, i) => {
    const t = isRecord(point) ? point.t : undefined
    if (!isNumber(t)) throw new PlanError(`${what}第 ${i + 1} 个点缺少时间 t`)
    if (i > 0 && t <= (times[i - 1] as number)) {
      throw new PlanError(`${what}第 ${i + 1} 个点的时间不大于前一个点`)
    }
    times[i] = t
  })
  return times
}

function readJoints(trajectory: unknown): {
  names: string[]
  times: Float64Array
  positions: Float32Array
} {
  const names = isRecord(trajectory) ? trajectory.joint_names : undefined
  if (
    !Array.isArray(names) ||
    names.length === 0 ||
    !names.every((name): name is string => typeof name === 'string' && name !== '')
  ) {
    throw new PlanError('规划文件缺少关节名 joint_names')
  }
  if (new Set(names).size !== names.length) throw new PlanError('关节名 joint_names 有重复')
  const list = points(trajectory, '关节轨迹')
  const times = readTimes(list, '关节轨迹')
  const joints = names.length
  const positions = new Float32Array(list.length * joints)
  list.forEach((point, i) => {
    const values = (point as Record<string, unknown>).positions
    if (!Array.isArray(values) || values.length !== joints || !values.every(isNumber)) {
      throw new PlanError(`关节轨迹第 ${i + 1} 个点的关节值不是 ${joints} 个数`)
    }
    positions.set(values, i * joints)
  })
  return { names, times, positions }
}

/**
 * 失败路径（接口文档 11.1 的 failed_paths）：可选，没有时省略、为空数组或 null。每段的点按顺序连线，
 * 段与段之间不连。点数不足 2 个的段画不出线，这里不报错，由文件校验工具检查（11.2）。
 * 同时返回各段所属的表面，用于检查它们在规划范围内；没有 surface_id 的段记为空字符串。
 */
function readFailed(value: unknown): { positions: Float32Array; surfaceIds: string[] } {
  if (value === undefined || value === null) {
    return { positions: new Float32Array(0), surfaceIds: [] }
  }
  if (!Array.isArray(value)) throw new PlanError('规划文件的失败路径 failed_paths 不是数组')
  const surfaceIds = value.map((path) =>
    isRecord(path) && typeof path.surface_id === 'string' ? path.surface_id : '',
  )
  const paths = value.map((path, i) => {
    const list = isRecord(path) ? path.points : undefined
    if (!Array.isArray(list)) throw new PlanError(`失败路径第 ${i + 1} 段缺少 points`)
    list.forEach((point, j) => {
      const p = isRecord(point) ? point.p : undefined
      if (!Array.isArray(p) || p.length !== 3 || !p.every(isNumber)) {
        throw new PlanError(`失败路径第 ${i + 1} 段第 ${j + 1} 个点的位置 p 不是 3 个数`)
      }
    })
    return list as { p: Vec3 }[]
  })
  const count = paths.reduce((sum, list) => sum + Math.max(0, list.length - 1), 0)
  const failed = new Float32Array(count * 6)
  let o = 0
  for (const list of paths) {
    for (let k = 0; k + 1 < list.length; k++) {
      failed.set((list[k] as { p: Vec3 }).p, o)
      failed.set((list[k + 1] as { p: Vec3 }).p, o + 3)
      o += 6
    }
  }
  return { positions: failed, surfaceIds }
}

function readIds(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((id): id is string => typeof id === 'string')) {
    throw new PlanError(`规划文件的 ${field} 不是字符串数组`)
  }
  return [...new Set(value)]
}

/**
 * 表面集合（接口文档 11.2）：两个字段都没有时为 null，按旧服务端的规划文件处理；只有一个，或者有效选择、
 * surface_ids、失败路径的表面不在规划范围内，视为加载失败。表面是否属于模型、能否清洗不在这里检查。
 */
function readScope(
  json: Record<string, unknown>,
  surfaceIds: readonly string[],
  failedSurfaceIds: readonly string[],
): PlanScope | null {
  const hasSelected = json.selected_surface_ids !== undefined
  const hasPlanning = json.planning_scope_surface_ids !== undefined
  if (!hasSelected && !hasPlanning) return null
  if (!hasSelected || !hasPlanning) {
    throw new PlanError(
      `规划文件只有 ${hasSelected ? 'selected_surface_ids' : 'planning_scope_surface_ids'}，` +
        'selected_surface_ids 和 planning_scope_surface_ids 应同时给出',
    )
  }
  const selected = readIds(json.selected_surface_ids, 'selected_surface_ids')
  const planning = readIds(json.planning_scope_surface_ids, 'planning_scope_surface_ids')
  const inScope = new Set(planning)
  const outside = (ids: readonly string[]) => ids.find((id) => !inScope.has(id))
  const checks: [string | undefined, string][] = [
    [outside(selected), '有效选择 selected_surface_ids 中的表面'],
    [outside(surfaceIds), 'surface_ids 中的表面'],
    [outside(failedSurfaceIds), '失败路径的表面'],
  ]
  for (const [id, what] of checks) {
    if (id !== undefined) {
      throw new PlanError(`${what} ${id || '（空）'} 不在规划范围 planning_scope_surface_ids 中`)
    }
  }
  return { selected, planning }
}

class ArrowBuilder {
  readonly positions: number[] = []
  readonly directions: number[] = []
  readonly times: number[] = []

  add(x: number, y: number, z: number, dx: number, dy: number, dz: number, t: number): void {
    this.positions.push(x, y, z)
    this.directions.push(dx, dy, dz)
    this.times.push(t)
  }

  build(): Arrows {
    return {
      positions: Float32Array.from(this.positions),
      directions: Float32Array.from(this.directions),
      times: Float64Array.from(this.times),
    }
  }
}

/**
 * 解析规划文件。expected 为 SystemState 中的 plan_id、model_id，不一致视为加载失败（接口文档 11.1）；
 * arrowSpacing 为方向箭头的间距，米（需求 10.2 的 path_arrow_spacing_m）。
 */
export function parsePlan(
  json: unknown,
  expected: { planId: string; modelId: string },
  arrowSpacing: number,
): PlanData {
  if (!isRecord(json)) throw new PlanError('规划文件不是 JSON 对象')
  if (json.plan_id !== expected.planId) {
    throw new PlanError(`规划文件的 plan_id 为 ${String(json.plan_id)}，应为 ${expected.planId}`)
  }
  if (json.model_id !== expected.modelId) {
    throw new PlanError(`规划文件的 model_id 为 ${String(json.model_id)}，应为 ${expected.modelId}`)
  }
  const duration = json.duration
  if (!isNumber(duration) || duration < 0) throw new PlanError('规划文件缺少任务总时长 duration')
  const surfaceIds = Array.isArray(json.surface_ids)
    ? json.surface_ids.filter((id): id is string => typeof id === 'string')
    : []

  const joints = readJoints(json.joint_trajectory)

  const list = points(json.tcp_path, ' TCP 路径')
  const times = readTimes(list, 'TCP 路径')
  const n = list.length
  const xyz = new Float64Array(n * 3)
  const on = new Uint8Array(n)
  list.forEach((point, i) => {
    const { p, process_on: processOn } = point as Record<string, unknown>
    if (!Array.isArray(p) || p.length !== 3 || !p.every(isNumber)) {
      throw new PlanError(`TCP 路径第 ${i + 1} 个点的位置 p 不是 3 个数`)
    }
    if (typeof processOn !== 'boolean') {
      throw new PlanError(`TCP 路径第 ${i + 1} 个点缺少 process_on`)
    }
    xyz.set(p, i * 3)
    on[i] = processOn ? 1 : 0
  })

  let processCount = 0
  for (let k = 0; k + 1 < n; k++) if (on[k] && on[k + 1]) processCount++
  const process = new Float32Array(processCount * 6)
  const processEnds = new Float64Array(processCount)
  const travel = new Float32Array((n - 1 - processCount) * 6)
  const processArrows = new ArrowBuilder()
  const travelArrows = new ArrowBuilder()
  let pi = 0
  let ti = 0
  // 箭头沿同一类线段连续的一段路程按间距放置，每段路程从半个间距处开始
  let previous = -1
  let next = 0
  for (let k = 0; k + 1 < n; k++) {
    const isProcess = on[k] === 1 && on[k + 1] === 1
    const a = k * 3
    const b = a + 3
    const segment = xyz.subarray(a, b + 3)
    if (isProcess) {
      process.set(segment, pi * 6)
      processEnds[pi++] = times[k + 1] as number
    } else {
      travel.set(segment, ti++ * 6)
    }

    const kind = isProcess ? 1 : 0
    if (kind !== previous) {
      previous = kind
      next = arrowSpacing / 2
    }
    const dx = (xyz[b] as number) - (xyz[a] as number)
    const dy = (xyz[b + 1] as number) - (xyz[a + 1] as number)
    const dz = (xyz[b + 2] as number) - (xyz[a + 2] as number)
    const length = Math.hypot(dx, dy, dz)
    if (length === 0) continue
    const arrows = isProcess ? processArrows : travelArrows
    const t0 = times[k] as number
    const dt = (times[k + 1] as number) - t0
    for (; next <= length; next += arrowSpacing) {
      const f = next / length
      arrows.add(
        (xyz[a] as number) + dx * f,
        (xyz[a + 1] as number) + dy * f,
        (xyz[a + 2] as number) + dz * f,
        dx / length,
        dy / length,
        dz / length,
        t0 + dt * f,
      )
    }
    next -= length
  }

  const { positions: failed, surfaceIds: failedSurfaceIds } = readFailed(json.failed_paths)
  const scope = readScope(json, surfaceIds, failedSurfaceIds)

  // 包围盒也包括失败路径，框选视角时红色路径不被裁掉
  const min: Vec3 = [Infinity, Infinity, Infinity]
  const max: Vec3 = [-Infinity, -Infinity, -Infinity]
  for (const values of [xyz, failed]) {
    for (let i = 0; i < values.length; i += 3) {
      for (const axis of [0, 1, 2] as const) {
        const v = values[i + axis] as number
        if (v < min[axis]) min[axis] = v
        if (v > max[axis]) max[axis] = v
      }
    }
  }
  const pointAt = (i: number): Vec3 => [
    xyz[i * 3] as number,
    xyz[i * 3 + 1] as number,
    xyz[i * 3 + 2] as number,
  ]

  return {
    planId: expected.planId,
    modelId: expected.modelId,
    surfaceIds,
    scope,
    duration,
    jointNames: joints.names,
    jointTimes: joints.times,
    jointPositions: joints.positions,
    process,
    processEnds,
    travel,
    failed,
    processArrows: processArrows.build(),
    travelArrows: travelArrows.build(),
    start: pointAt(0),
    end: pointAt(n - 1),
    min,
    max,
  }
}

export interface PlanRequest {
  /** 规划文件的完整 URL */
  url: string
  planId: string
  modelId: string
  arrowSpacing: number
}

export interface PlanResult {
  data: PlanData
  /** 下载完成的时刻，Unix 毫秒；Worker 与主线程的 performance 时间起点不同，用它换算 */
  downloadedAt: number
  downloadMs: number
  parseMs: number
}

/** 主线程发给 Worker 的消息：加载一个规划文件，或中止进行中的加载。id 是主线程分配的请求编号。 */
export type PlanWorkerMessage =
  { type: 'load'; id: number; request: PlanRequest } | { type: 'abort'; id: number }

/** Worker 交回主线程的消息，id 与请求对应。 */
export type PlanReply = { id: number } & (
  ({ ok: true } & PlanResult) | { ok: false; error: string }
)

/** 下载并解析规划文件。下载失败、HTTP 状态不是 2xx、不是有效的 JSON 时抛出 PlanError。 */
export async function fetchPlan(
  request: PlanRequest,
  fetchFile: typeof fetch,
  signal?: AbortSignal,
): Promise<PlanResult> {
  const started = performance.now()
  let text: string
  try {
    const response = await fetchFile(request.url, { signal })
    if (!response.ok) throw new PlanError(`下载失败：HTTP ${response.status}`)
    text = await response.text()
  } catch (error) {
    if (error instanceof PlanError || signal?.aborted) throw error
    throw new PlanError(`下载失败：${error instanceof Error ? error.message : String(error)}`)
  }
  const downloaded = performance.now()
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw new PlanError('规划文件不是有效的 JSON')
  }
  const data = parsePlan(json, request, request.arrowSpacing)
  return {
    data,
    downloadedAt: performance.timeOrigin + downloaded,
    downloadMs: downloaded - started,
    parseMs: performance.now() - downloaded,
  }
}
