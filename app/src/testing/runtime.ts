/** 测试用的 runtime：内存中的 Preferences，假的 rosbridge。不进入打包产物。 */
import { memoryPreferences, type Platform } from '../platform/index.ts'
import { SERVICES } from '../ros/contract.ts'
import { startRuntime, type Runtime } from '../runtime.ts'
import { FakeRosbridge, type FakeSocket } from './fakeRos.ts'
import type { SystemState } from '../ros/contract.ts'

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

export async function testRuntime(): Promise<{
  runtime: Runtime
  bridge: FakeRosbridge
  platform: TestPlatform
}> {
  const bridge = new FakeRosbridge()
  const platform = testPlatform()
  const runtime = await startRuntime(platform, bridge.connect)
  return { runtime, bridge, platform }
}

/** 回复 GetSystemState。 */
export function answerGet(socket: FakeSocket, state: SystemState): void {
  socket.respond(SERVICES.getSystemState.name, { state })
}
