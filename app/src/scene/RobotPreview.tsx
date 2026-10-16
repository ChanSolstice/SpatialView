/**
 * 轨迹动画中的机械臂（需求 6.6）：按动画时钟插值关节角驱动机械臂，路径由 TcpPath 按同一时钟着色。
 * 纯前端演示，不向服务端发送任何指令。
 */
import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo } from 'react'
import { selectAnimationData } from '../store/selectors.ts'
import { useApp, useRuntime } from '../ui/runtimeContext.ts'
import { poseAt } from './animation.ts'

/** 按需渲染时两帧之间可能隔了很久（例如刚按下播放），每帧最多推进的时间，秒。 */
const MAX_FRAME_STEP = 0.1

export function RobotPreview() {
  const { store } = useRuntime()
  const animating = useApp((s) => s.mode === 'animate')
  const data = useApp(selectAnimationData)
  const time = useApp((s) => s.animation.time)
  const playing = useApp((s) => s.animation.playing)
  const invalidate = useThree((s) => s.invalidate)
  const values = useMemo(() => new Float64Array(data?.joints.length ?? 0), [data])
  const active = animating && data !== null

  // 暂停时拖动进度条、重新播放时也要更新姿态；开始播放时请求第一帧
  useEffect(() => {
    if (!active) return
    poseAt(data, time, values)
    invalidate()
  }, [active, data, invalidate, playing, time, values])

  useFrame((_, delta) => {
    const { animation, setAnimation } = store.getState()
    if (!active || !animation.playing) return
    const duration = data.plan.data.duration
    const next = Math.min(
      duration,
      animation.time + Math.min(delta, MAX_FRAME_STEP) * animation.speed,
    )
    poseAt(data, next, values)
    // 播放结束后停在最后一帧
    setAnimation({ time: next, playing: next < duration })
    invalidate()
  })

  if (!active) return null
  return <primitive object={data.robot.root} />
}
