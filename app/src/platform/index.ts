/**
 * Capacitor 插件的封装（架构设计 5.1）：Preferences、前后台、返回键、屏幕常亮。
 * 在浏览器中使用插件自带的 Web 实现作为替身：Preferences 存在 localStorage，页面重新可见时触发 resume；
 * 浏览器没有返回键，用 Esc 键代替。
 */
import { KeepAwake } from '@capacitor-community/keep-awake'
import { App } from '@capacitor/app'
import { Capacitor, type PluginListenerHandle } from '@capacitor/core'
import { Preferences } from '@capacitor/preferences'

export interface PreferenceStore {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  remove(key: string): Promise<void>
}

export interface Platform {
  preferences: PreferenceStore
  /** APP 回到前台（需求 7.3）。返回取消监听的函数。 */
  onResume(listener: () => void): () => void
  /** 返回键（需求 3.5）。注册后系统默认的退出行为被接管。 */
  onBackButton(listener: () => void): () => void
  /** 运行期间保持亮屏（需求 12.1）。浏览器不支持时忽略。 */
  keepAwake(): Promise<void>
}

/** 插件的监听注册是异步的；返回同步的取消函数，注册完成前取消也能正确移除。 */
function listen(register: () => Promise<PluginListenerHandle>): () => void {
  const handle = register()
  return () => {
    handle.then((h) => h.remove()).catch(() => {})
  }
}

export function createPlatform(): Platform {
  const native = Capacitor.isNativePlatform()
  return {
    preferences: {
      get: async (key) => (await Preferences.get({ key })).value,
      set: (key, value) => Preferences.set({ key, value }),
      remove: (key) => Preferences.remove({ key }),
    },
    onResume: (listener) => listen(() => App.addListener('resume', listener)),
    onBackButton: (listener) => {
      if (native) return listen(() => App.addListener('backButton', () => listener()))
      const onKey = (event: KeyboardEvent) => {
        if (event.key === 'Escape') listener()
      }
      window.addEventListener('keydown', onKey)
      return () => window.removeEventListener('keydown', onKey)
    },
    keepAwake: async () => {
      try {
        await KeepAwake.keepAwake()
      } catch {
        // 浏览器不支持 Wake Lock 时忽略；平板上由原生插件实现
      }
    },
  }
}

/** 内存中的 Preferences，用于测试。 */
export function memoryPreferences(initial: Record<string, string> = {}): PreferenceStore {
  const values = new Map(Object.entries(initial))
  return {
    get: async (key) => values.get(key) ?? null,
    set: async (key, value) => {
      values.set(key, value)
    },
    remove: async (key) => {
      values.delete(key)
    },
  }
}
