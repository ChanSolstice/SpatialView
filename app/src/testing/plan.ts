/** 测试用：按接口文档第 11 节生成小的规划文件。不进入打包产物。 */

export const I5H_JOINTS = [
  'shoulder_joint',
  'upperArm_joint',
  'foreArm_joint',
  'wrist1_joint',
  'wrist2_joint',
  'wrist3_joint',
]

export interface TestPlanOptions {
  planId: string
  modelId: string
  jointNames?: string[]
  /** 点数，默认 11：0–10 秒，每秒一个点 */
  points?: number
}

/**
 * 沿 X 轴从 0.3 米走到 0.5 米的路径：前一半为工艺段，后一半为空行程；第 j 个关节的角度为 j × t / 100。
 */
export function testPlanJson({
  planId,
  modelId,
  jointNames = I5H_JOINTS,
  points = 11,
}: TestPlanOptions): object {
  const last = points - 1
  const times = Array.from({ length: points }, (_, i) => i)
  return {
    plan_id: planId,
    model_id: modelId,
    frame_id: 'base_link',
    surface_ids: ['s1', 's2'],
    duration: last,
    joint_trajectory: {
      joint_names: jointNames,
      points: times.map((t) => ({ t, positions: jointNames.map((_, j) => (j * t) / 100) })),
    },
    tcp_path: {
      points: times.map((t) => ({
        t,
        p: [0.3 + (0.2 * t) / last, 0.05, 0.1],
        process_on: t <= last / 2,
      })),
    },
  }
}
