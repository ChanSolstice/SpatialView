/**
 * 三维场景（需求第 6 节；架构设计 5.7；前端UI设计第 5 节）。场景世界坐标即 base_link，Z 轴向上，单位米。
 * 按需渲染：画面没有变化时不重绘；手势由 OrbitControls 触发重绘，store 中与场景有关的变化由各组件调用 invalidate。
 */
import { Bvh, OrbitControls } from '@react-three/drei'
import { Canvas, useThree, type ThreeEvent } from '@react-three/fiber'
import { useEffect, useRef, type ComponentRef } from 'react'
import { Vector3, type PerspectiveCamera } from 'three'
import { measure, MODEL_DOWNLOADED_MARK } from '../assets/loader.ts'
import { SCREEN_LINE_MATERIALS } from '../assets/materials.ts'
import { sceneContent } from '../domain/phase.ts'
import { useApp, useRuntime } from '../ui/runtimeContext.ts'
import { defaultCameraPosition, EMPTY_RADIUS, fitDistance } from './camera.ts'
import { applyAppearance } from './materialFor.ts'
import { TcpPath } from './TcpPath.tsx'
import './scene.css'

/** 相机：Z 轴向上，绕观察中心旋转，双指缩放，不能平移；新模型加载完成和请求恢复默认视角时回到默认视角。 */
function CameraRig() {
  const { config } = useRuntime()
  const scene = config.config.scene
  const model = useApp((s) => s.model.data)
  const resets = useApp((s) => s.viewResets)
  const controls = useRef<ComponentRef<typeof OrbitControls>>(null)
  const camera = useThree((s) => s.camera) as PerspectiveCamera
  const invalidate = useThree((s) => s.invalidate)
  const radius = model?.sphere.radius ?? EMPTY_RADIUS

  useEffect(() => {
    const target = model?.sphere.center.clone() ?? new Vector3(...scene.default_target)
    // 画布尺寸变化时 react-three-fiber 会更新 aspect；只在这里取用，不因尺寸变化重置视角
    const distance = fitDistance(radius, camera.fov, camera.aspect)
    camera.position.copy(defaultCameraPosition(target, scene.default_view_direction, distance))
    controls.current?.target.copy(target)
    controls.current?.update()
    invalidate()
  }, [
    camera,
    invalidate,
    model,
    radius,
    resets,
    scene.default_target,
    scene.default_view_direction,
  ])

  return (
    <OrbitControls
      ref={controls}
      makeDefault
      enablePan={false}
      enableDamping={false}
      minDistance={radius * scene.zoom_min_ratio}
      maxDistance={radius * scene.zoom_max_ratio}
    />
  )
}

/** 工件：材质随场景模式和选择切换；选面模式中点选表面，按下到抬起移动超过阈值视为拖动（需求 6.2、6.4）。 */
function Workpiece() {
  const { store, config } = useRuntime()
  const model = useApp((s) => s.model.data)
  const mode = useApp((s) => s.mode)
  const selection = useApp((s) => s.selection)
  const phase = useApp((s) => s.server?.phase ?? null)
  const invalidate = useThree((s) => s.invalidate)
  const { workpiece } = sceneContent(phase, mode)
  const threshold = config.config.scene.tap_threshold_px

  useEffect(() => {
    if (!model) return
    applyAppearance(model, workpiece, selection)
    invalidate()
  }, [invalidate, model, selection, workpiece])

  // 记录模型下载完成到第一次绘制的耗时（需求 12.2），绘制在下一帧完成
  useEffect(() => {
    if (!model) return
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => measure('model-display', MODEL_DOWNLOADED_MARK))
    })
    return () => cancelAnimationFrame(frame)
  }, [model])

  if (!model || workpiece === 'none') return null
  const pick = (event: ThreeEvent<MouseEvent>) => {
    if (event.delta > threshold) return
    event.stopPropagation()
    const id: unknown = event.object.userData.surface_id
    if (typeof id === 'string') store.getState().toggleSurface(id)
  }
  return (
    <>
      {/* 模型变化时重新挂载，为新模型的表面建立拾取加速结构 */}
      <Bvh firstHitOnly key={model.id}>
        <primitive object={model.group} onClick={workpiece === 'selectable' ? pick : undefined} />
      </Bvh>
      <primitive object={model.boundaries} />
    </>
  )
}

/** 线宽以屏幕像素计的材质（表面分界线、路径）按画布尺寸设置分辨率。 */
function ScreenLines() {
  const size = useThree((s) => s.size)
  const invalidate = useThree((s) => s.invalidate)
  useEffect(() => {
    for (const material of SCREEN_LINE_MATERIALS) material.resolution.set(size.width, size.height)
    invalidate()
  }, [invalidate, size])
  return null
}

/** 地面网格：base_link 的 XY 平面（z = 0），以原点为中心，作为方向和尺度参照（需求 6.3）。 */
function Ground() {
  const { config } = useRuntime()
  const { grid_size_m: size, grid_cell_m: cell } = config.config.scene
  return (
    <gridHelper
      args={[size, Math.round(size / cell), 0xaab4c0, 0xc9d1da]}
      rotation={[Math.PI / 2, 0, 0]}
      material-transparent
      material-opacity={0.85}
    />
  )
}

/** 开发服务器中把场景挂到 window.spatialviewScene，便于在浏览器调试工具中查看；打包产物中不挂载。 */
function DevHandle() {
  const state = useThree()
  useEffect(() => {
    Object.assign(window, { spatialviewScene: state })
  }, [state])
  return null
}

export function SceneCanvas() {
  return (
    <Canvas
      frameloop="demand"
      // 与前端UI设计的颜色一致：不做色调映射
      flat
      dpr={[1, 2]}
      camera={{ fov: 38, near: 0.01, far: 50, up: [0, 0, 1], position: [2, -2, 1.6] }}
      gl={{ antialias: true, alpha: true }}
    >
      <hemisphereLight args={[0xffffff, 0x8f9aa6, 1.5]} />
      <directionalLight position={[3.5, -1.2, 2.6]} intensity={2.1} />
      <directionalLight position={[-2, 2.5, 1.5]} intensity={0.7} color={0xe8f0ff} />
      <Ground />
      <ScreenLines />
      <CameraRig />
      <Workpiece />
      <TcpPath />
      {import.meta.env.DEV && <DevHandle />}
    </Canvas>
  )
}
