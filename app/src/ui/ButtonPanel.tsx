/**
 * 按钮栏（需求 5.1、5.3；前端UI设计 4.2）。各按钮的可用性、文字和样式全部来自 availability。
 * 不可用的按钮仍然显示，位置不变。
 */
import { Fragment } from 'react'
import {
  confirmation,
  isConfirmAction,
  type ButtonView,
  type PanelButton,
} from '../domain/availability.ts'
import { selectAvailability } from '../store/selectors.ts'
import { EStopButton } from './EStopButton.tsx'
import { Icon, type IconName } from './Icon.tsx'
import { useApp, useRuntime } from './runtimeContext.ts'
import './ButtonPanel.css'

const ICONS: Record<ButtonView['action'], IconName> = {
  scan: 'scan',
  enterSelect: 'select',
  plan: 'plan',
  enterAnimate: 'anim',
  start: 'play',
  pause: 'pause',
  resume: 'play',
  stop: 'stop',
  laserOn: 'laser',
  laserOff: 'laser',
  resetEstop: 'estop',
}

function className(view: ButtonView): string {
  if (view.variant === 'progress') return 'btn is-progress'
  if (view.variant === 'active') return 'btn is-active'
  if (view.variant === 'warn') return 'btn is-warn'
  if (view.variant === 'primary') return 'btn is-primary'
  return view.enabled || view.busy ? 'btn' : 'btn is-disabled'
}

const GROUPS: PanelButton[][] = [
  ['scan', 'select', 'plan', 'animate'],
  ['main', 'stop', 'laser'],
]

export function ButtonPanel() {
  const { store, commands } = useRuntime()
  const { buttons } = useApp(selectAvailability)

  const press = (view: ButtonView) => {
    if (!view.enabled) return
    const s = store.getState()
    switch (view.action) {
      case 'enterSelect':
        return s.setMode('select')
      case 'enterAnimate':
        return s.setMode('animate')
      case 'laserOff':
        return void commands.laserOff()
      default:
        if (!view.confirm || !isConfirmAction(view.action)) return void commands.run(view.action)
        s.pushDialog({
          kind: 'confirm',
          action: view.action,
          confirmation: confirmation(view.action, s.server, s.selection.size),
        })
    }
  }

  return (
    <aside className="panel">
      {GROUPS.map((group, i) => (
        <Fragment key={i}>
          {i > 0 && <div className="panel-divider" />}
          {group.map((key) => {
            const view = buttons[key]
            return (
              <button
                key={key}
                type="button"
                className={className(view)}
                disabled={!view.enabled}
                aria-busy={view.busy}
                data-testid={`btn-${key}`}
                onClick={() => press(view)}
              >
                {view.busy ? <span className="spinner" /> : <Icon name={ICONS[view.action]} />}
                <span>{view.label}</span>
              </button>
            )
          })}
        </Fragment>
      ))}
      <div className="panel-divider" />
      <EStopButton />
    </aside>
  )
}
