/**
 * 短时提示（需求 5.5、7.3；前端UI设计 4.5）：成功 2 秒、失败 5 秒后自动消失，也可以点关闭；
 * 新提示替换旧提示，不堆叠。
 */
import { useEffect } from 'react'
import { Icon } from './Icon.tsx'
import { useApp, useRuntime } from './runtimeContext.ts'
import './ToastHost.css'

const TOAST_MS = { success: 2000, error: 5000 }

export function ToastHost() {
  const { store } = useRuntime()
  const toast = useApp((s) => s.toast)

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => store.getState().clearToast(toast.id), TOAST_MS[toast.tone])
    return () => clearTimeout(timer)
  }, [store, toast])

  if (!toast) return null
  return (
    <div className={`toast ${toast.tone}`} role="status" key={toast.id}>
      <Icon name={toast.tone === 'success' ? 'check' : 'warn'} />
      <div>
        <div className="toast-title">{toast.title}</div>
        {toast.detail && <div className="toast-detail">{toast.detail}</div>}
        {toast.code && <div className="toast-code">{toast.code}</div>}
      </div>
      <button
        type="button"
        className="toast-close"
        aria-label="关闭"
        onClick={() => store.getState().clearToast(toast.id)}
      >
        <Icon name="close" />
      </button>
    </div>
  )
}
