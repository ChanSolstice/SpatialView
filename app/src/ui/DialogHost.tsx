/**
 * 对话框（需求 5.4、5.5；前端UI设计 4.4）。同一时间只显示一个，其余排队。
 * 确认框在对应操作不可用时由 store 监听自动关闭（store/listeners.ts）。
 */
import type { ReactNode } from 'react'
import type { ResultTone } from '../domain/results.ts'
import type { Dialog } from '../store/store.ts'
import { Icon, type IconName } from './Icon.tsx'
import { useApp, useRuntime } from './runtimeContext.ts'
import './DialogHost.css'

const RESULT_ICON: Record<ResultTone, [string, IconName]> = {
  error: ['error', 'warn'],
  partial: ['warn', 'warn'],
  success: ['success', 'check'],
}

function Code({ code }: { code: string }) {
  return code ? <div className="dlg-code">{code}</div> : null
}

function Body({
  icon,
  tone,
  title,
  children,
}: {
  icon: IconName
  tone: string
  title: string
  children: ReactNode
}) {
  return (
    <div className="dlg-body">
      <div className={`dlg-icon ${tone}`}>
        <Icon name={icon} />
      </div>
      <div>
        <div className="dlg-title">{title}</div>
        {children}
      </div>
    </div>
  )
}

function DialogView({
  dialog,
  close,
  confirm,
}: {
  dialog: Dialog
  close(): void
  confirm(): void
}) {
  switch (dialog.kind) {
    case 'confirm': {
      const { title, lines, confirmLabel } = dialog.confirmation
      return (
        <div className="dlg" role="dialog" aria-label={title}>
          <Body icon="warn" tone="warn" title={title}>
            {lines.map((line) => (
              <div className="dlg-text" key={line}>
                {line}
              </div>
            ))}
          </Body>
          <div className="dlg-foot">
            <button type="button" className="dbtn" onClick={close}>
              取消
            </button>
            <button type="button" className="dbtn primary" onClick={confirm}>
              {confirmLabel}
            </button>
          </div>
        </div>
      )
    }
    case 'result': {
      const { title, tone, reason, detail, code } = dialog.notice
      const [iconTone, icon] = RESULT_ICON[tone]
      return (
        <div className="dlg" role="dialog" aria-label={title}>
          <Body icon={icon} tone={iconTone} title={title}>
            {reason && <div className="dlg-text">{reason}</div>}
            {detail && <div className="dlg-detail">{detail}</div>}
            <Code code={code} />
          </Body>
          <div className="dlg-foot">
            <button type="button" className="dbtn primary" onClick={close}>
              确定
            </button>
          </div>
        </div>
      )
    }
    case 'info':
      return (
        <div className="dlg" role="dialog" aria-label={dialog.title}>
          <Body icon="info" tone="info" title={dialog.title}>
            <div className="dlg-text">{dialog.text}</div>
          </Body>
          <div className="dlg-foot">
            <button type="button" className="dbtn primary" onClick={close}>
              确定
            </button>
          </div>
        </div>
      )
    case 'safety':
      return (
        <div className="dlg" role="alertdialog" aria-label={dialog.title}>
          <div className="dlg-band">
            <Icon name="estop" />
            {dialog.title}
          </div>
          <div className="dlg-big">{dialog.text}</div>
          <div className="dlg-sub">
            {dialog.reason && <div>{dialog.reason}</div>}
            {dialog.detail && <div>{dialog.detail}</div>}
            <Code code={dialog.code} />
          </div>
          <div className="dlg-foot">
            <button type="button" className="dbtn danger" onClick={close}>
              我知道了
            </button>
          </div>
        </div>
      )
  }
}

export function DialogHost() {
  const { store, commands } = useRuntime()
  const dialog = useApp((s) => s.dialogs[0])
  if (!dialog) return null

  const close = () => store.getState().closeDialog(dialog.id)
  const confirm = () => {
    close()
    if (dialog.kind === 'confirm') void commands.run(dialog.action)
  }
  return (
    <div className="scrim">
      <DialogView dialog={dialog} close={close} confirm={confirm} />
    </div>
  )
}
