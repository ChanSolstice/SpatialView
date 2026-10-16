/** 界面取得 runtime 和 store 的方式。 */
import { createContext, useContext } from 'react'
import { useStore } from 'zustand'
import type { Runtime } from '../runtime.ts'
import type { AppActions, AppState } from '../store/store.ts'

export const RuntimeContext = createContext<Runtime | null>(null)

export function useRuntime(): Runtime {
  const runtime = useContext(RuntimeContext)
  if (runtime === null) throw new Error('界面组件需要放在 RuntimeContext.Provider 中')
  return runtime
}

/** 订阅 store 的一部分。selector 返回新对象时应先缓存（store/selectors.ts），否则每次都会重新渲染。 */
export function useApp<T>(selector: (s: AppState & AppActions) => T): T {
  return useStore(useRuntime().store, selector)
}
