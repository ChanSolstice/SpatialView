/**
 * 启动时组装各模块（架构设计 7.1）：合并配置、建立 store、连接管理、状态同步和指令通道，
 * 注册前后台和返回键。界面通过 RuntimeProvider 取得这里的对象。
 */
import { installModelLoader } from './assets/loader.ts'
import { installPlanLoader, type LoadPlan } from './assets/planLoader.ts'
import { installRobotLoader, type LoadRobotModel } from './assets/robot.ts'
import { devServerUrls, loadConfig, type LoadedConfig } from './config/load.ts'
import type { Platform, PreferenceStore } from './platform/index.ts'
import { createCommands, type Commands } from './ros/commands.ts'
import { ConnectionManager } from './ros/connection.ts'
import { createStateSync } from './ros/stateSync.ts'
import { connectRoslib, type Connect } from './ros/transport.ts'
import { installListeners } from './store/listeners.ts'
import { installLocalAlarms } from './store/localAlarms.ts'
import { createAppStore, type AppStore } from './store/store.ts'

export const REFRESH_TOAST = {
  ok: '连接成功',
  failed: '服务端连接失败，请检查网络',
}

export interface Runtime {
  config: LoadedConfig
  /** 工程入口保存覆盖配置时使用 */
  preferences: PreferenceStore
  store: AppStore
  connection: ConnectionManager
  commands: Commands
  dispose(): void
}

/**
 * 返回键（架构设计 5.8）：有弹窗时关闭弹窗；告警面板展开时收起；处于选面或轨迹动画模式时退出模式；
 * 其他情况不做任何事。
 */
export function handleBack(store: AppStore): void {
  const s = store.getState()
  const [dialog] = s.dialogs
  if (dialog) s.closeDialog(dialog.id)
  else if (s.alarmPanelOpen) s.setAlarmPanel(false)
  else if (s.mode !== 'browse') s.setMode('browse')
}

export interface RuntimeOptions {
  connect?: Connect
  /** 下载模型文件（测试中替换） */
  fetchFile?: typeof fetch
  /** 下载和解析规划文件，默认在 Worker 中进行（测试中替换） */
  loadPlan?: LoadPlan
  /** 加载随 APP 打包的机械臂模型（测试中替换） */
  loadRobot?: LoadRobotModel
}

export async function startRuntime(
  platform: Platform,
  { connect = connectRoslib, fetchFile, loadPlan, loadRobot }: RuntimeOptions = {},
): Promise<Runtime> {
  const config = await loadConfig(platform.preferences, devServerUrls())
  const { server, timing, scene, robot, integration } = config.config
  const store = createAppStore()
  const sync = createStateSync(store, {
    assumeLaserConnected: integration.assume_laser_connected,
  })
  const connection = new ConnectionManager(
    { url: server.rosbridge_url, timing, connect },
    {
      onStatus: (status, socketOpen) => store.getState().setConn({ status, socketOpen }),
      onState: (raw, source) =>
        sync(source === 'get' ? (raw as { state?: unknown } | null)?.state : raw, source),
      onDisconnect: () => store.getState().releaseCommand(),
      onRefreshResult: (ok) =>
        store
          .getState()
          .showToast(
            ok
              ? { tone: 'success', title: REFRESH_TOAST.ok, detail: '', code: '' }
              : { tone: 'error', title: REFRESH_TOAST.failed, detail: '', code: '' },
          ),
    },
  )
  const commands = createCommands(store, connection, sync, timing)
  const cleanups = [
    installListeners(store),
    installLocalAlarms(store),
    installModelLoader(store, server.http_base_url, fetchFile),
    installPlanLoader(store, server.http_base_url, scene.path_arrow_spacing_m, loadPlan),
    installRobotLoader(store, robot, import.meta.env.BASE_URL, loadRobot),
    // Android 可能在后台暂停了 WebView 的定时器和网络，回到前台时刷新连接（需求 7.3）
    platform.onResume(() => connection.refresh(false)),
    platform.onBackButton(() => handleBack(store)),
  ]
  void platform.keepAwake()
  connection.start()
  return {
    config,
    preferences: platform.preferences,
    store,
    connection,
    commands,
    dispose: () => {
      connection.stop()
      for (const cleanup of cleanups) cleanup()
    },
  }
}
