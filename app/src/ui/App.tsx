/** 主界面（需求 5.1；架构设计 5.8）。 */
import { ButtonPanel } from './ButtonPanel.tsx'
import { DialogHost } from './DialogHost.tsx'
import { SceneArea } from './SceneArea.tsx'
import { StatusBar } from './StatusBar.tsx'
import './App.css'

export function App() {
  return (
    <div className="app">
      <StatusBar />
      <div className="app-main">
        <SceneArea />
        <ButtonPanel />
      </div>
      <DialogHost />
    </div>
  )
}
