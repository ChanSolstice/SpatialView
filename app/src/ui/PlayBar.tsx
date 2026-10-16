/**
 * 轨迹动画的标签和播放条（需求 6.6；前端UI设计 4.3）：播放 / 暂停、重新播放、可拖动的进度条、
 * 当前时间 / 总时长、倍速、退出。纯前端演示，不向服务端发送任何指令。
 */
import { useRef, type PointerEvent } from 'react'
import { selectAnimationData } from '../store/selectors.ts'
import { formatClock } from './format.ts'
import { Icon } from './Icon.tsx'
import { useApp, useRuntime } from './runtimeContext.ts'
import './PlayBar.css'

export function AnimationTag() {
  const animating = useApp((s) => s.mode === 'animate')
  if (!animating) return null
  return (
    <div className="anim-tag" data-testid="animation-tag">
      <Icon name="anim" />
      轨迹动画 · 非实际位置
    </div>
  )
}

export function PlayBar() {
  const { store, config } = useRuntime()
  const animating = useApp((s) => s.mode === 'animate')
  const duration = useApp((s) => selectAnimationData(s)?.plan.data.duration ?? 0)
  const { time, playing, speed } = useApp((s) => s.animation)
  const dragging = useRef<{ resume: boolean } | null>(null)
  if (!animating) return null

  const set = store.getState().setAnimation
  const toggle = () => {
    if (playing) return set({ playing: false })
    // 停在最后一帧时，播放从头开始
    set({ playing: true, ...(time >= duration ? { time: 0 } : {}) })
  }
  const seek = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const fraction = rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0
    set({ time: Math.min(1, Math.max(0, fraction)) * duration })
  }
  const fraction = duration > 0 ? Math.min(1, time / duration) : 0

  return (
    <div className="playbar" data-testid="playbar">
      <button
        type="button"
        className="playbar-button playbar-play"
        aria-label={playing ? '暂停' : '播放'}
        onClick={toggle}
      >
        <Icon name={playing ? 'pause' : 'play'} />
      </button>
      <button
        type="button"
        className="playbar-button"
        aria-label="重新播放"
        onClick={() => set({ time: 0, playing: true })}
      >
        <Icon name="replay" />
      </button>
      <div
        className="playbar-track"
        role="slider"
        aria-label="播放进度"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(time)}
        // 拖动期间暂停，松开后恢复之前的播放状态
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId)
          dragging.current = { resume: playing }
          set({ playing: false })
          seek(event)
        }}
        onPointerMove={(event) => {
          if (dragging.current) seek(event)
        }}
        onPointerUp={(event) => {
          const resume = dragging.current?.resume ?? false
          dragging.current = null
          event.currentTarget.releasePointerCapture(event.pointerId)
          if (resume && store.getState().animation.time < duration) set({ playing: true })
        }}
        onPointerCancel={() => {
          dragging.current = null
        }}
      >
        <div className="playbar-rail">
          <i className="playbar-fill" style={{ width: `${fraction * 100}%` }} />
          <i className="playbar-thumb" style={{ left: `${fraction * 100}%` }} />
        </div>
      </div>
      <span className="playbar-time">
        {formatClock(time)} / {formatClock(duration)}
      </span>
      <div className="playbar-speeds" role="group" aria-label="倍速">
        {config.config.animation.speeds.map((value) => (
          <button
            key={value}
            type="button"
            className={value === speed ? 'is-on' : undefined}
            aria-pressed={value === speed}
            onClick={() => set({ speed: value })}
          >
            {value}×
          </button>
        ))}
      </div>
      <button
        type="button"
        className="tool-button"
        onClick={() => store.getState().setMode('browse')}
      >
        <Icon name="close" />
        退出
      </button>
    </div>
  )
}
