/**
 * 用阶段 1 生成的样例（samples/）检查规划文件的解析：与 manifest 中的统计一致，时间轴与 duration 对齐。
 * 大样例只在存在时检查（不进入仓库的环境中跳过）。
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parsePlan } from '../src/assets/plan.ts'
import { repoRoot } from './docs.ts'

interface Manifest {
  plan_id: string
  model_id: string
  plan: string
  points: number
  process_points: number
  duration: number
  process_intervals: [number, number][]
}

function load(size: string): { manifest: Manifest; json: unknown } | null {
  const dir = path.join(repoRoot, 'samples', size)
  if (!existsSync(path.join(dir, 'manifest.json'))) return null
  const manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf-8')) as Manifest
  const json: unknown = JSON.parse(readFileSync(path.join(dir, manifest.plan), 'utf-8'))
  return { manifest, json }
}

describe.each(['small', 'large'])('样例规划文件（%s）', (size) => {
  const sample = load(size)

  it.skipIf(sample === null)('解析结果与 manifest 一致', () => {
    const { manifest, json } = sample!
    const data = parsePlan(json, { planId: manifest.plan_id, modelId: manifest.model_id }, 0.16)
    expect(data.duration).toBeCloseTo(manifest.duration, 6)
    expect(data.jointTimes.length).toBe(manifest.points)
    expect(data.jointTimes.at(-1)).toBeCloseTo(manifest.duration, 3)
    expect(data.jointPositions.length).toBe(manifest.points * data.jointNames.length)
    // 每段工艺区间的点数比线段数多 1
    expect(data.processEnds.length).toBe(
      manifest.process_points - manifest.process_intervals.length,
    )
    expect(data.process.length / 6 + data.travel.length / 6).toBe(manifest.points - 1)
    expect(data.processArrows.times.length).toBeGreaterThan(0)
    // 箭头的时间非递减，进度着色按它判断
    const times = data.processArrows.times
    expect(times.every((t, i) => i === 0 || t >= (times[i - 1] as number))).toBe(true)
  })
})
