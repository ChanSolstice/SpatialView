import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createPlatform } from './platform/index.ts'
import { startRuntime } from './runtime.ts'
import { App } from './ui/App.tsx'
import { RuntimeContext } from './ui/runtimeContext.ts'
import './ui/theme.css'

const root = document.getElementById('root')
if (!root) throw new Error('缺少 #root 节点')

const runtime = await startRuntime(createPlatform())
// 开发时便于在浏览器调试工具中查看状态
if (import.meta.env.DEV) Object.assign(window, { spatialview: runtime })

createRoot(root).render(
  <StrictMode>
    <RuntimeContext.Provider value={runtime}>
      <App />
    </RuntimeContext.Provider>
  </StrictMode>,
)
