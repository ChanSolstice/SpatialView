/** 测试用的 runtime：内存中的 Preferences，假的 rosbridge。不进入打包产物。 */
import { inThreadLoadPlan } from '../assets/planLoader.ts'
import { memoryPreferences, type Platform } from '../platform/index.ts'
import { SERVICES, type SystemState } from '../ros/contract.ts'
import { startRuntime, type Runtime } from '../runtime.ts'
import { FakeRosbridge, type FakeSocket } from './fakeRos.ts'
import { STATE_IDS } from './fixtures.ts'
import { buildGlb, gridSurface } from './glb.ts'
import { testPlanJson } from './plan.ts'
import { testRobotModel } from './robot.ts'

export interface TestPlatform extends Platform {
  resume(): void
  back(): void
}

export function testPlatform(): TestPlatform {
  const resume: (() => void)[] = []
  const back: (() => void)[] = []
  const listen = (list: (() => void)[]) => (listener: () => void) => {
    list.push(listener)
    return () => list.splice(list.indexOf(listener), 1)
  }
  return {
    preferences: memoryPreferences(),
    onResume: listen(resume),
    onBackButton: listen(back),
    keepAwake: async () => {},
    resume: () => resume.forEach((listener) => listener()),
    back: () => back.forEach((listener) => listener()),
  }
}

/** 以 _expand 结尾的规划：选了 s2，规划范围扩展进 s1，s2 整个表面没有生成路径（接口文档 11.1）。 */
export const EXPANDED_PLAN = { surfaceIds: ['s1'], selected: ['s2'], planning: ['s1', 's2'] }

/**
 * 文件服务的替身：/models/<model_id>.glb 返回一个有两个可选表面、一个不可选表面的模型；
 * /plans/<plan_id>.json 返回测试用的规划（model_id 为测试状态中的模型），plan_id 以 _expand 结尾的
 * 带上 EXPANDED_PLAN 的表面集合。
 */
export const serveFiles = (async (input: RequestInfo | URL) => {
  const plan = /\/plans\/([\w-]+)\.json$/.exec(String(input))
  if (plan?.[1]) {
    const options = plan[1].endsWith('_expand') ? EXPANDED_PLAN : {}
    return new Response(
      JSON.stringify(testPlanJson({ planId: plan[1], modelId: STATE_IDS.model, ...options })),
    )
  }
  const match = /\/models\/([\w-]+)\.glb$/.exec(String(input))
  if (!match) return new Response(null, { status: 404 })
  const surfaces = [
    gridSurface('s1', 0.3, 0, 0.1),
    gridSurface('s2', 0.4, 0, 0.1),
    { ...gridSurface('s3', 0.3, 0.1, 0.1), selectable: false },
  ]
  return new Response(buildGlb(surfaces, { model_id: match[1] }))
}) as typeof fetch

export async function testRuntime(): Promise<{
  runtime: Runtime
  bridge: FakeRosbridge
  platform: TestPlatform
}> {
  const bridge = new FakeRosbridge()
  const platform = testPlatform()
  const runtime = await startRuntime(platform, {
    connect: bridge.connect,
    fetchFile: serveFiles,
    loadPlan: inThreadLoadPlan(serveFiles),
    loadRobot: () => Promise.resolve(testRobotModel()),
  })
  return { runtime, bridge, platform }
}

/** 回复 GetSystemState。 */
export function answerGet(socket: FakeSocket, state: SystemState): void {
  socket.respond(SERVICES.getSystemState.name, { state })
}
