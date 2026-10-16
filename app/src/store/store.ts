/**
 * APP 的 Zustand store（架构设计 5.2）。各模块只通过这里的 action 写入自己负责的部分：
 * ros 写连接状态、服务端状态镜像、在途指令和最近结果 ID；assets 写模型、规划和加载类本地告警；
 * ui、scene 写场景模式、选择集合和弹窗队列。
 */
import { createStore, type StoreApi } from 'zustand/vanilla'
import type { LoadedModel } from '../assets/model.ts'
import type { LoadedPlan } from '../assets/path.ts'
import type { Confirmation, ConfirmAction } from '../domain/availability.ts'
import type { ResultNotice } from '../domain/results.ts'
import type { AssetStatus, CommandKey, ConnStatus, SceneMode } from '../domain/types.ts'
import type { SystemState } from '../ros/contract.ts'

export interface AssetSlot<T> {
  /** 正在加载或已加载的 model_id / plan_id；为 null 表示没有。 */
  id: string | null
  status: AssetStatus
  /** 当前显示的数据。新的准备好之前保留旧的，准备好之后再替换（架构设计 5.6）。 */
  data: T | null
  /** 加载失败的原因（本地告警，需求 9.1）。 */
  error: string | null
}

export interface ConnState {
  status: ConnStatus
  /** WebSocket 是否打开。急停只看它（架构设计 5.5）。 */
  socketOpen: boolean
  sessionId: string | null
  seq: number
}

export type Dialog =
  | { id: number; kind: 'confirm'; action: ConfirmAction; confirmation: Confirmation }
  | { id: number; kind: 'result'; notice: ResultNotice }
  | { id: number; kind: 'info'; title: string; text: string }
  /** 急停发送失败、激光关闭失败（前端UI设计 4.4）。 */
  | {
      id: number
      kind: 'safety'
      title: string
      text: string
      reason: string
      detail: string
      code: string
    }

type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never
/** 加入队列时由 store 分配 id。 */
export type DialogInput = WithoutId<Dialog>

export interface Toast {
  id: number
  tone: 'error' | 'success'
  title: string
  detail: string
  code: string
}

export interface AppState {
  conn: ConnState
  server: SystemState | null
  /** 最近一次收到的消息不符合接口约定（zod 校验失败）的说明；为 null 表示正常。 */
  contractError: string | null
  inflight: CommandKey | null
  /** 尚未回复的关闭激光调用数。 */
  laserOffPending: number
  lastResultId: string | null

  model: AssetSlot<LoadedModel>
  plan: AssetSlot<LoadedPlan>

  mode: SceneMode
  /** 选中的 surface_id，本地状态：退出选面后保留，模型变化时清空（需求 6.4）。 */
  selection: ReadonlySet<string>
  /** 选择集合是在哪个模型和规划上初始化的；与当前不同时，进入选面时重新取初始选择。 */
  selectionBasis: string | null
  /** 每次加 1，三维场景恢复默认视角（需求 6.2）。 */
  viewResets: number
  dialogs: Dialog[]
  toast: Toast | null
}

export interface AppActions {
  setConn(patch: Partial<ConnState>): void
  /** stateSync 写入通过校验的服务端状态。 */
  setServer(state: SystemState, cursor: { sessionId: string; seq: number }): void
  setContractError(error: string | null): void
  setLastResultId(id: string): void
  /** 加在途锁；已有指令在途时返回 false。 */
  beginCommand(key: CommandKey): boolean
  endCommand(key: CommandKey): void
  /** 断线时立即解除在途锁（需求 7.4）。 */
  releaseCommand(): void
  laserOffStarted(): void
  laserOffFinished(): void
  setModel(patch: Partial<AssetSlot<LoadedModel>>): void
  setPlan(patch: Partial<AssetSlot<LoadedPlan>>): void
  setMode(mode: SceneMode): void
  setSelection(selection: ReadonlySet<string>, basis?: string | null): void
  /** 进入选面：初始选择为当前规划使用的表面，没有规划时为空；相机恢复默认视角（需求 6.4）。 */
  enterSelect(): void
  /** 选面模式中点选表面：未选中则加入，已选中则移除；不可选的表面不响应。 */
  toggleSurface(id: string): void
  resetView(): void
  pushDialog(dialog: DialogInput): void
  closeDialog(id: number): void
  showToast(toast: Omit<Toast, 'id'>): void
  clearToast(id: number): void
}

export type AppStore = StoreApi<AppState & AppActions>

export const INITIAL_STATE: AppState = {
  conn: { status: 'connecting', socketOpen: false, sessionId: null, seq: 0 },
  server: null,
  contractError: null,
  inflight: null,
  laserOffPending: 0,
  lastResultId: null,
  model: { id: null, status: 'idle', data: null, error: null },
  plan: { id: null, status: 'idle', data: null, error: null },
  mode: 'browse',
  selection: new Set(),
  selectionBasis: null,
  viewResets: 0,
  dialogs: [],
  toast: null,
}

export function createAppStore(initial: Partial<AppState> = {}): AppStore {
  let nextId = 1
  return createStore<AppState & AppActions>()((set, get) => ({
    ...INITIAL_STATE,
    ...initial,

    setConn: (patch) => set((s) => ({ conn: { ...s.conn, ...patch } })),
    setServer: (state, cursor) => set((s) => ({ server: state, conn: { ...s.conn, ...cursor } })),
    setContractError: (contractError) => set({ contractError }),
    setLastResultId: (lastResultId) => set({ lastResultId }),

    beginCommand: (key) => {
      if (get().inflight !== null) return false
      set({ inflight: key })
      return true
    },
    endCommand: (key) => set((s) => (s.inflight === key ? { inflight: null } : {})),
    releaseCommand: () => set({ inflight: null }),
    laserOffStarted: () => set((s) => ({ laserOffPending: s.laserOffPending + 1 })),
    laserOffFinished: () => set((s) => ({ laserOffPending: Math.max(0, s.laserOffPending - 1) })),

    setModel: (patch) => set((s) => ({ model: { ...s.model, ...patch } })),
    setPlan: (patch) => set((s) => ({ plan: { ...s.plan, ...patch } })),
    setMode: (mode) => set({ mode }),
    setSelection: (selection, basis) =>
      set(basis === undefined ? { selection } : { selection, selectionBasis: basis }),
    enterSelect: () =>
      set((s) => {
        const server = s.server
        const basis = `${server?.model_id ?? ''}|${server?.plan_id ?? ''}`
        let selection = s.selection
        if (basis !== s.selectionBasis) {
          const surfaces = s.model.data?.surfaces
          const planned = server?.plan_id ? server.plan_surface_ids : []
          selection = new Set(planned.filter((id) => !surfaces || surfaces.get(id)?.selectable))
        }
        return { mode: 'select', selection, selectionBasis: basis, viewResets: s.viewResets + 1 }
      }),
    toggleSurface: (id) =>
      set((s) => {
        if (s.mode !== 'select' || !s.model.data?.surfaces.get(id)?.selectable) return {}
        const selection = new Set(s.selection)
        if (!selection.delete(id)) selection.add(id)
        return { selection }
      }),
    resetView: () => set((s) => ({ viewResets: s.viewResets + 1 })),

    pushDialog: (dialog) =>
      set((s) => {
        // 连续按下急停时，同样的安全警示只显示一个
        if (
          dialog.kind === 'safety' &&
          s.dialogs.some((d) => d.kind === 'safety' && d.title === dialog.title)
        ) {
          return {}
        }
        return { dialogs: [...s.dialogs, { ...dialog, id: nextId++ } as Dialog] }
      }),
    closeDialog: (id) => set((s) => ({ dialogs: s.dialogs.filter((d) => d.id !== id) })),
    // 新提示替换旧提示，不堆叠（前端UI设计 4.5）
    showToast: (toast) => set({ toast: { ...toast, id: nextId++ } }),
    clearToast: (id) => set((s) => (s.toast?.id === id ? { toast: null } : {})),
  }))
}
