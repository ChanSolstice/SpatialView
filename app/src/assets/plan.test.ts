import { describe, expect, it } from 'vitest'
import { parsePlan, planBuffers, PlanError } from './plan.ts'

const IDS = { planId: 'plan_a', modelId: 'model_a' }
const JOINTS = ['j1', 'j2']

interface TcpPoint {
  t: number
  p: number[]
  process_on: boolean
}

/** 规划文件：tcp 为 TCP 路径点，关节轨迹取同样的时间轴。 */
function plan(tcp: TcpPoint[], extra: Record<string, unknown> = {}) {
  return {
    plan_id: 'plan_a',
    model_id: 'model_a',
    frame_id: 'base_link',
    surface_ids: ['s1'],
    duration: tcp.at(-1)?.t ?? 0,
    joint_trajectory: {
      joint_names: JOINTS,
      points: tcp.map(({ t }, i) => ({ t, positions: [i, -i] })),
    },
    tcp_path: { points: tcp },
    ...extra,
  }
}

const pt = (t: number, x: number, on: boolean): TcpPoint => ({ t, p: [x, 0, 0.1], process_on: on })

describe('parsePlan：线段', () => {
  // 0→1 工艺，1→2 空行程（激光关闭），2→3 空行程，3→4 工艺
  const tcp = [
    pt(0, 0, true),
    pt(1, 0.1, true),
    pt(2, 0.2, false),
    pt(3, 0.3, true),
    pt(4, 0.4, true),
  ]

  it('两端都处于工艺段的相邻两点为工艺段，其余为空行程', () => {
    const data = parsePlan(plan(tcp), IDS, 1)
    expect([...data.process].map((v) => +v.toFixed(6))).toEqual([
      0, 0, 0.1, 0.1, 0, 0.1, 0.3, 0, 0.1, 0.4, 0, 0.1,
    ])
    expect([...data.processEnds]).toEqual([1, 4])
    expect(data.travel.length).toBe(2 * 6)
    expect(data.start).toEqual([0, 0, 0.1])
    expect(data.end.map((v) => +v.toFixed(6))).toEqual([0.4, 0, 0.1])
    expect(data.min.map((v) => +v.toFixed(6))).toEqual([0, 0, 0.1])
    expect(data.max.map((v) => +v.toFixed(6))).toEqual([0.4, 0, 0.1])
  })

  it('关节轨迹按点依次存放', () => {
    const data = parsePlan(plan(tcp), IDS, 1)
    expect(data.jointNames).toEqual(JOINTS)
    expect([...data.jointTimes]).toEqual([0, 1, 2, 3, 4])
    expect([...data.jointPositions]).toEqual([0, -0, 1, -1, 2, -2, 3, -3, 4, -4])
    expect(data.duration).toBe(4)
    expect(data.surfaceIds).toEqual(['s1'])
  })

  it('全部缓冲区都可以转移，且互不相同', () => {
    const buffers = planBuffers(parsePlan(plan(tcp), IDS, 0.05))
    expect(new Set(buffers).size).toBe(buffers.length)
    expect(buffers.every((b) => b instanceof ArrayBuffer)).toBe(true)
  })
})

describe('parsePlan：失败路径（接口文档 11.1 的 failed_paths）', () => {
  const tcp = [pt(0, 0, true), pt(1, 0.1, true)]
  const failedPaths = [
    {
      surface_id: 's2',
      points: [{ p: [0.5, 0, 0.1] }, { p: [0.5, 0.1, 0.1] }, { p: [0.5, 0.2, 0.3] }],
    },
    { surface_id: 's3', points: [{ p: [-0.2, 0, 0] }, { p: [-0.1, 0, 0] }] },
  ]

  it('每段的点按顺序连成线段，段与段之间不连', () => {
    const data = parsePlan(plan(tcp, { failed_paths: failedPaths }), IDS, 1)
    expect([...data.failed].map((v) => +v.toFixed(6))).toEqual([
      0.5, 0, 0.1, 0.5, 0.1, 0.1, 0.5, 0.1, 0.1, 0.5, 0.2, 0.3, -0.2, 0, 0, -0.1, 0, 0,
    ])
    // 不影响工艺段、空行程和进度
    expect(data.process.length).toBe(6)
    expect(data.travel.length).toBe(0)
    expect([...data.processEnds]).toEqual([1])
  })

  it('包围盒包括失败路径', () => {
    const data = parsePlan(plan(tcp, { failed_paths: failedPaths }), IDS, 1)
    expect(data.min.map((v) => +v.toFixed(6))).toEqual([-0.2, 0, 0])
    expect(data.max.map((v) => +v.toFixed(6))).toEqual([0.5, 0.2, 0.3])
    expect(data.start).toEqual([0, 0, 0.1])
  })

  it.each([
    ['省略', undefined],
    ['为空数组', []],
    ['为 null', null],
  ])('没有失败路径：%s', (_, value) => {
    const json = value === undefined ? plan(tcp) : plan(tcp, { failed_paths: value })
    expect(parsePlan(json, IDS, 1).failed.length).toBe(0)
  })

  it('点数不足 2 个的段画不出线，不报错（由文件校验工具检查）', () => {
    const json = plan(tcp, {
      failed_paths: [
        { surface_id: 's2', points: [{ p: [0, 0, 0] }] },
        { surface_id: 's2', points: [] },
      ],
    })
    expect(parsePlan(json, IDS, 1).failed.length).toBe(0)
  })

  it('结构不对时加载失败', () => {
    const fails = (value: unknown, message: RegExp) =>
      expect(() => parsePlan(plan(tcp, { failed_paths: value }), IDS, 1)).toThrow(message)
    fails({}, /failed_paths 不是数组/)
    fails([{ surface_id: 's2' }], /失败路径第 1 段缺少 points/)
    fails(
      [failedPaths[0], { surface_id: 's3', points: [{ p: [0, 0, 0] }, { p: [0, 0] }] }],
      /失败路径第 2 段第 2 个点的位置 p 不是 3 个数/,
    )
    fails([{ points: [{ t: 0 }] }], /第 1 段第 1 个点/)
  })

  it('失败路径的缓冲区也可以转移', () => {
    const data = parsePlan(plan(tcp, { failed_paths: failedPaths }), IDS, 1)
    expect(planBuffers(data)).toContain(data.failed.buffer)
  })
})

describe('parsePlan：有效选择和规划范围（接口文档 11.1、11.2）', () => {
  const tcp = [pt(0, 0, true), pt(1, 0.1, true)]
  const failed = (surface: string) => [
    { surface_id: surface, points: [{ p: [0, 0, 0] }, { p: [1, 0, 0] }] },
  ]
  const parse = (extra: Record<string, unknown>) =>
    parsePlan(plan(tcp, { surface_ids: ['s1', 's3'], ...extra }), IDS, 1)

  it('读出两个集合，去掉重复', () => {
    const data = parse({
      selected_surface_ids: ['s1', 's2', 's1'],
      planning_scope_surface_ids: ['s1', 's2', 's3'],
      failed_paths: failed('s3'),
    })
    expect(data.scope).toEqual({ selected: ['s1', 's2'], planning: ['s1', 's2', 's3'] })
    expect(data.surfaceIds).toEqual(['s1', 's3'])
  })

  it('有效选择不要求包含在 surface_ids 内：整个表面都失败的仍是操作员的选择', () => {
    const data = parse({
      selected_surface_ids: ['s2'],
      planning_scope_surface_ids: ['s1', 's2', 's3'],
    })
    expect(data.scope?.selected).toEqual(['s2'])
  })

  it('两个字段都没有时为 null，按旧服务端的规划文件处理', () => {
    expect(parse({}).scope).toBeNull()
  })

  it('只有一个字段、不是字符串数组或包含关系不对时加载失败', () => {
    const fails = (extra: Record<string, unknown>, message: RegExp) =>
      expect(() => parse(extra)).toThrow(message)
    fails({ selected_surface_ids: ['s1'] }, /只有 selected_surface_ids/)
    fails({ planning_scope_surface_ids: ['s1', 's3'] }, /只有 planning_scope_surface_ids/)
    fails(
      { selected_surface_ids: 's1', planning_scope_surface_ids: ['s1', 's3'] },
      /selected_surface_ids 不是字符串数组/,
    )
    fails(
      { selected_surface_ids: ['s1'], planning_scope_surface_ids: ['s1', 3] },
      /planning_scope_surface_ids 不是字符串数组/,
    )
    fails(
      { selected_surface_ids: ['s2'], planning_scope_surface_ids: ['s1', 's3'] },
      /有效选择 selected_surface_ids 中的表面 s2 不在规划范围/,
    )
    fails(
      { selected_surface_ids: ['s1'], planning_scope_surface_ids: ['s1'] },
      /surface_ids 中的表面 s3 不在规划范围/,
    )
    fails(
      {
        selected_surface_ids: ['s1'],
        planning_scope_surface_ids: ['s1', 's3'],
        failed_paths: failed('s9'),
      },
      /失败路径的表面 s9 不在规划范围/,
    )
    fails(
      {
        selected_surface_ids: ['s1'],
        planning_scope_surface_ids: ['s1', 's3'],
        failed_paths: [{ points: [{ p: [0, 0, 0] }, { p: [1, 0, 0] }] }],
      },
      /失败路径的表面 （空） 不在规划范围/,
    )
  })

  it('没有表面集合时不检查失败路径的表面', () => {
    expect(parse({ failed_paths: failed('s9') }).failed.length).toBe(6)
  })
})

describe('parsePlan：方向箭头', () => {
  it('沿同一类线段连续的路程按间距放置，从半个间距处开始，方向为线段方向', () => {
    // 一条 1 米长的工艺段路程，由两段 0.5 米组成
    const tcp = [pt(0, 0, true), pt(5, 0.5, true), pt(10, 1, true)]
    const { processArrows, travelArrows } = parsePlan(plan(tcp), IDS, 0.3)
    const xs = [...processArrows.positions].filter((_, i) => i % 3 === 0).map((v) => +v.toFixed(6))
    expect(xs).toEqual([0.15, 0.45, 0.75])
    expect([...processArrows.times].map((v) => +v.toFixed(6))).toEqual([1.5, 4.5, 7.5])
    expect([...processArrows.directions.subarray(0, 3)]).toEqual([1, 0, 0])
    expect(travelArrows.positions.length).toBe(0)
  })

  it('线段类型变化时重新从半个间距处开始；长度为 0 的线段不放箭头', () => {
    const tcp = [
      pt(0, 0, false),
      pt(1, 0.2, false),
      pt(2, 0.2, true),
      pt(3, 0.2, true),
      pt(4, 0.6, true),
    ]
    const { processArrows, travelArrows } = parsePlan(plan(tcp), IDS, 0.2)
    expect(
      [...travelArrows.positions].filter((_, i) => i % 3 === 0).map((v) => +v.toFixed(6)),
    ).toEqual([0.1])
    // 2→3 是长度为 0 的工艺段；3→4 从 x = 0.2 起，0.3、0.5 处各一个
    expect(
      [...processArrows.positions].filter((_, i) => i % 3 === 0).map((v) => +v.toFixed(6)),
    ).toEqual([0.3, 0.5])
  })
})

describe('parsePlan：校验', () => {
  const tcp = [pt(0, 0, true), pt(1, 0.1, true)]
  const fails = (json: unknown, message: RegExp) => {
    expect(() => parsePlan(json, IDS, 0.1)).toThrow(PlanError)
    expect(() => parsePlan(json, IDS, 0.1)).toThrow(message)
  }

  it('plan_id、model_id 与 SystemState 不一致（接口文档 11.1）', () => {
    fails(plan(tcp, { plan_id: 'plan_b' }), /plan_id 为 plan_b，应为 plan_a/)
    fails(plan(tcp, { model_id: 'model_b' }), /model_id 为 model_b，应为 model_a/)
  })

  it('结构不对', () => {
    fails([], /不是 JSON 对象/)
    fails(plan(tcp, { duration: 'x' }), /duration/)
    fails(plan(tcp, { tcp_path: { points: [] } }), /缺少 TCP 路径/)
    fails(plan(tcp, { joint_trajectory: { joint_names: [], points: [] } }), /joint_names/)
    fails(
      plan(tcp, {
        joint_trajectory: { joint_names: ['a', 'a'], points: [{ t: 0, positions: [0, 0] }] },
      }),
      /重复/,
    )
    fails(
      plan(tcp, { joint_trajectory: { joint_names: JOINTS, points: [{ t: 0, positions: [0] }] } }),
      /第 1 个点的关节值不是 2 个数/,
    )
    fails(plan([pt(0, 0, true), { t: 1, p: [0, 0], process_on: true }]), /第 2 个点的位置 p/)
    fails(plan([pt(0, 0, true), { t: 1, p: [0, 0, 0] } as TcpPoint]), /第 2 个点缺少 process_on/)
  })

  it('时间不严格递增（接口文档 11.2）', () => {
    const joints = plan(tcp).joint_trajectory
    fails(
      plan([pt(0, 0, true), pt(1, 0.1, true), pt(1, 0.2, true)], { joint_trajectory: joints }),
      /TCP 路径第 3 个点的时间不大于前一个点/,
    )
    fails(
      plan(tcp, {
        joint_trajectory: {
          joint_names: JOINTS,
          points: [
            { t: 0.5, positions: [0, 0] },
            { t: 0.2, positions: [0, 0] },
          ],
        },
      }),
      /关节轨迹第 2 个点的时间/,
    )
  })
})
