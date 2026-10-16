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
