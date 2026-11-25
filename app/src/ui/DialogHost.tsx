/**
 * 对话框（需求 5.4、5.5；前端UI设计 4.4）。同一时间只显示一个，其余排队。
 * 确认框在对应操作不可用时由 store 监听自动关闭（store/listeners.ts）。
 */
import { useEffect, useState, type ReactNode } from 'react'
import { confirmation } from '../domain/availability.ts'
import { rangeLines } from '../domain/planRange.ts'
import { resultHint, type ResultNotice, type ResultTone } from '../domain/results.ts'
import type { WorkpieceType } from '../ros/contract.ts'
import { selectPlanRange } from '../store/selectors.ts'
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

type ConfirmDialog = Extract<Dialog, { kind: 'confirm' }>

/**
 * 确认框。文案按当前状态得出，开始清洗的设备异常警告随状态更新；开始扫描先选择工件类型；
 * 上电确认后弹出第二次确认，第二次的确认按钮延迟才可以按（需求 5.4）。
 */
function ConfirmView({ dialog, close }: { dialog: ConfirmDialog; close(): void }) {
  const { store, commands } = useRuntime()
  const server = useApp((s) => s.server)
  const selectionSize = useApp((s) => s.selection.size)
  const view = confirmation(dialog.action, server, selectionSize, dialog.step)
  const [choice, setChoice] = useState<WorkpieceType | null>(null)
  const [ready, setReady] = useState(view.confirmDelayMs === 0)
  useEffect(() => {
    if (ready) return
    const timer = setTimeout(() => setReady(true), view.confirmDelayMs)
    return () => clearTimeout(timer)
  }, [ready, view.confirmDelayMs])

  const choosing = view.choices.length > 0
  const canConfirm = ready && (!choosing || choice !== null)
  const confirm = () => {
    if (!canConfirm) return
    close()
    if (view.next) store.getState().pushDialog({ kind: 'confirm', action: dialog.action, step: 2 })
    else void commands.run(dialog.action, choice !== null ? { workpieceType: choice } : {})
  }
  const lines = view.lines.map((line) => (
    <div className={choosing ? 'dlg-text dlg-note' : 'dlg-text'} key={line}>
      {line}
    </div>
  ))
  return (
    <div className="dlg" role="dialog" aria-label={view.title}>
      <Body icon={choosing ? 'scan' : 'warn'} tone={choosing ? 'info' : 'warn'} title={view.title}>
        {view.warnings.length > 0 && (
          <ul className="dlg-warnings">
            {view.warnings.map((warning) => (
              <li key={warning}>
                <Icon name="warn" />
                {warning}
              </li>
            ))}
          </ul>
        )}
        {!choosing && lines}
      </Body>
      {choosing && (
        <>
          <div className="dlg-choices" role="radiogroup" aria-label={view.title}>
            {view.choices.map((option) => {
              const selected = choice === option.value
              return (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  className={selected ? 'dlg-choice is-selected' : 'dlg-choice'}
                  onClick={() => setChoice(option.value)}
                >
                  <span className="dlg-choice-name">{option.name}</span>
                  <span className="dlg-choice-text">{option.text}</span>
                  {selected && <Icon name="check" />}
                </button>
              )
            })}
          </div>
          {lines}
        </>
      )}
      <div className="dlg-foot">
        <button type="button" className="dbtn" onClick={close}>
          取消
        </button>
        <button type="button" className="dbtn primary" disabled={!canConfirm} onClick={confirm}>
          {view.confirmLabel}
        </button>
      </div>
    </div>
  )
}

/**
 * 结果提示框（需求 5.5）：原因、补充说明、规划范围的说明（这次规划加载后出现）、操作提示（随当前阶段变化）、
 * 状态码。
 */
function ResultView({ notice, close }: { notice: ResultNotice; close(): void }) {
  const phase = useApp((s) => s.server?.phase)
  const range = useApp((s) =>
    notice.planId !== undefined && s.plan.data?.id === notice.planId ? selectPlanRange(s) : null,
  )
  const { title, tone, reason, detail, code } = notice
  const hint = resultHint(notice, phase)
  const [iconTone, icon] = RESULT_ICON[tone]
  return (
    <div className="dlg" role="dialog" aria-label={title}>
      <Body icon={icon} tone={iconTone} title={title}>
        {reason && <div className="dlg-text">{reason}</div>}
        {detail && <div className="dlg-detail">{detail}</div>}
        {rangeLines(range).map((line) => (
          <div className="dlg-hint" key={line}>
            {line}
          </div>
        ))}
        {hint && <div className="dlg-hint">{hint}</div>}
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

function DialogView({ dialog, close }: { dialog: Dialog; close(): void }) {
  switch (dialog.kind) {
    case 'confirm':
      return <ConfirmView key={dialog.id} dialog={dialog} close={close} />
    case 'result':
      return <ResultView notice={dialog.notice} close={close} />
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
  const { store } = useRuntime()
  const dialog = useApp((s) => s.dialogs[0])
  if (!dialog) return null

  const close = () => store.getState().closeDialog(dialog.id)
  return (
    <div className="scrim">
      <DialogView dialog={dialog} close={close} />
    </div>
  )
}
