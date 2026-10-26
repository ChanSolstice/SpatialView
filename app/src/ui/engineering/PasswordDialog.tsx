/** 工程入口的密码对话框（前端UI设计 4.7）：标准对话框，一个数字密码输入框，"取消""确定"。 */
import { useState, type FormEvent } from 'react'

interface Props {
  verify(password: string): Promise<boolean>
  onPass(): void
  onCancel(): void
}

export function PasswordDialog({ verify, onPass, onCancel }: Props) {
  const [password, setPassword] = useState('')
  const [wrong, setWrong] = useState(false)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (await verify(password)) onPass()
    else {
      setWrong(true)
      setPassword('')
    }
  }
  return (
    <div className="scrim">
      <form className="dlg" role="dialog" aria-label="工程入口" onSubmit={(e) => void submit(e)}>
        <div className="eng-dialog-body">
          <div className="dlg-title">工程入口</div>
          <input
            className="eng-input"
            type="password"
            inputMode="numeric"
            autoComplete="off"
            aria-label="密码"
            placeholder="请输入密码"
            value={password}
            autoFocus
            onChange={(e) => {
              setPassword(e.target.value)
              setWrong(false)
            }}
          />
          {wrong && <div className="eng-error">密码错误</div>}
        </div>
        <div className="dlg-foot">
          <button type="button" className="dbtn" onClick={onCancel}>
            取消
          </button>
          <button type="submit" className="dbtn primary">
            确定
          </button>
        </div>
      </form>
    </div>
  )
}
