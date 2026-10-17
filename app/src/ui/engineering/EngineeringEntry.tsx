/**
 * 工程入口（需求 10.3）：长按 Status Bar 的 APP 名称 5 秒，输入密码后打开工程面板。长按期间不给任何视觉反馈。
 * 只在编译开关打开时打包（StatusBar 按 ENGINEERING_ENABLED 动态加载本模块）。
 */
import { useRef, useState, type ReactNode } from 'react'
import { checkPassword } from '../../config/engineering.ts'
import { EngineeringPanel } from './EngineeringPanel.tsx'
import { PasswordDialog } from './PasswordDialog.tsx'
import './Engineering.css'

const HOLD_MS = 5000

interface Props {
  children: ReactNode
  /** 校验密码，默认按打包时写入的摘要（测试中替换） */
  verify?: (password: string) => Promise<boolean>
}

export default function EngineeringEntry({ children, verify = checkPassword }: Props) {
  const [stage, setStage] = useState<'closed' | 'password' | 'panel'>('closed')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cancel = () => {
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = null
  }
  return (
    <>
      <div
        className="eng-hold"
        onPointerDown={() => {
          cancel()
          timer.current = setTimeout(() => setStage('password'), HOLD_MS)
        }}
        onPointerUp={cancel}
        onPointerLeave={cancel}
        onPointerCancel={cancel}
        // 长按不弹出系统菜单
        onContextMenu={(e) => e.preventDefault()}
      >
        {children}
      </div>
      {stage === 'password' && (
        <PasswordDialog
          verify={verify}
          onPass={() => setStage('panel')}
          onCancel={() => setStage('closed')}
        />
      )}
      {stage === 'panel' && <EngineeringPanel onClose={() => setStage('closed')} />}
    </>
  )
}
