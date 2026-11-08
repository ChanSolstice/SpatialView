/**
 * TCP 路径（需求 6.5；前端UI设计第 5 节）：规划就绪、轨迹动画和执行期间显示，起点、终点用标签标出；
 * 轨迹动画中按动画时钟、执行期间按 exec_time 给已走过的工艺段着色。
 */
import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import type { PerspectiveCamera } from 'three'
import { CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js'
import { measure } from '../assets/loader.ts'
import { PLAN_DOWNLOADED_MARK } from '../assets/planLoader.ts'
import { sceneContent } from '../domain/phase.ts'
import { useApp } from '../ui/runtimeContext.ts'
import { createPathLabels, placePathLabels, showPathLabels } from './labels.ts'

function labelRenderer(): CSS2DRenderer {
  const renderer = new CSS2DRenderer()
  renderer.domElement.className = 'scene-labels'
  return renderer
}

/** 标签层：叠在画布上，随场景的每次绘制更新标签的位置。 */
function LabelLayer() {
  const gl = useThree((s) => s.gl)
  const scene = useThree((s) => s.scene)
  const camera = useThree((s) => s.camera)
  const size = useThree((s) => s.size)
  const renderer = useMemo(() => labelRenderer(), [])

  useEffect(() => {
    const element = renderer.domElement
    gl.domElement.parentElement?.append(element)
    return () => element.remove()
  }, [gl, renderer])

  useEffect(() => renderer.setSize(size.width, size.height), [renderer, size])

  useFrame(() => renderer.render(scene, camera))
  return null
}

export function TcpPath() {
  const plan = useApp((s) => s.plan.data)
  const path = useApp((s) => sceneContent(s.server?.phase ?? null, s.mode).path)
  // 轨迹动画中的进度取动画时钟，执行期间取实际已执行时间（需求 6.5、6.6）
  const progress = useApp((s) =>
    path === 'animation'
      ? s.animation.time
      : path === 'execution'
        ? (s.server?.exec_time ?? 0)
        : null,
  )
  const invalidate = useThree((s) => s.invalidate)
  const labels = useMemo(() => createPathLabels(), [])
  const visible = plan !== null && path !== 'none'
  const measured = useRef<string | null>(null)

  useEffect(() => {
    if (plan) {
      plan.setProgress(progress)
      placePathLabels(labels, plan.start, plan.end)
    }
    showPathLabels(labels, visible)
    invalidate()
  }, [invalidate, labels, plan, progress, visible])

  // 箭头与屏幕平行、大小以屏幕像素计，每次绘制前按相机摆放（前端UI设计第 5 节）
  useFrame(({ camera, size }) => {
    if (visible) plan.fitArrows(camera as PerspectiveCamera, size.height)
  })

  // 记录规划文件下载完成到路径第一次绘制的耗时（需求 12.2）；同一份规划只记录一次
  useEffect(() => {
    if (!visible || measured.current === plan.id) return
    measured.current = plan.id
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => measure('plan-display', PLAN_DOWNLOADED_MARK))
    })
    return () => cancelAnimationFrame(frame)
  }, [plan, visible])

  return (
    <>
      <LabelLayer />
      {/* 标签的 DOM 元素只在标签离开场景本身时才移除，所以标签常驻场景，用 visible 显示和隐藏 */}
      <primitive object={labels.group} />
      {visible && <primitive object={plan.group} />}
    </>
  )
}
