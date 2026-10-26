// 录制演示视频时注入 APP 页面（tools/demo），在页面的脚本之前执行。
//
// 1. 接管时钟：setTimeout、setInterval、requestAnimationFrame、performance.now 和 Date 都改用虚拟时间，
//    只有录制工具调用 __demo.advance(毫秒) 时才前进：先按到期顺序执行定时器，再执行一次动画帧回调。
//    本机软件渲染一帧要零点几秒到几秒，这样每帧之间的时间仍然正好是 1/30 秒。延迟为 0 的定时器
//    不依赖时间流逝，仍用浏览器的定时器立即执行。Worker 中的时钟不受影响。
// 2. 触点标记：__demo.touches([{ x, y, opacity, scale }]) 按 CSS 像素画出手指的位置，不拦截触摸事件。
;(() => {
  const realSetTimeout = window.setTimeout.bind(window)
  const realClearTimeout = window.clearTimeout.bind(window)
  const RealDate = Date
  const startPerf = performance.now()
  const startDate = RealDate.now()
  let now = startPerf
  let nextId = 1
  // 虚拟定时器：id → { due, fn, args, interval }；延迟为 0 的定时器：id → 浏览器定时器的 id
  const timers = new Map()
  const immediate = new Map()
  let frameCallbacks = new Map()
  const errors = []

  const report = (error) => {
    errors.push(String((error && error.stack) || error))
    // 与浏览器一样，回调中的异常不影响其他回调，并作为未捕获的异常报告
    realSetTimeout(() => {
      throw error
    }, 0)
  }
  const run = (fn, args) => {
    try {
      if (typeof fn === 'function') fn(...args)
      else (0, eval)(String(fn))
    } catch (error) {
      report(error)
    }
  }
  const schedule = (fn, delay, args, repeat) => {
    const id = nextId++
    const ms = Math.max(0, Number(delay) || 0)
    if (ms === 0 && !repeat) {
      immediate.set(
        id,
        realSetTimeout(() => {
          immediate.delete(id)
          run(fn, args)
        }, 0),
      )
    } else {
      timers.set(id, { due: now + ms, fn, args, interval: repeat ? Math.max(1, ms) : 0 })
    }
    return id
  }
  const clear = (id) => {
    timers.delete(id)
    if (immediate.has(id)) {
      realClearTimeout(immediate.get(id))
      immediate.delete(id)
    }
  }

  window.setTimeout = (fn, delay, ...args) => schedule(fn, delay, args, false)
  window.setInterval = (fn, delay, ...args) => schedule(fn, delay, args, true)
  window.clearTimeout = clear
  window.clearInterval = clear
  window.requestAnimationFrame = (callback) => {
    const id = nextId++
    frameCallbacks.set(id, callback)
    return id
  }
  window.cancelAnimationFrame = (id) => frameCallbacks.delete(id)
  performance.now = () => now

  const dateNow = () => startDate + (now - startPerf)
  function DemoDate(...args) {
    if (!new.target) return new RealDate(dateNow()).toString()
    return args.length === 0 ? new RealDate(dateNow()) : new RealDate(...args)
  }
  DemoDate.prototype = RealDate.prototype
  DemoDate.now = dateNow
  DemoDate.parse = RealDate.parse
  DemoDate.UTC = RealDate.UTC
  window.Date = DemoDate

  let layer = null
  const markers = []
  const ensureLayer = () => {
    if (layer || !document.body) return layer
    layer = document.createElement('div')
    layer.setAttribute('data-demo', 'touches')
    layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647'
    document.body.appendChild(layer)
    return layer
  }

  window.__demo = {
    /** 时间前进 ms 毫秒：按到期顺序执行定时器（包括期间新加入的），再执行一次动画帧回调。 */
    advance(ms) {
      const target = now + ms
      for (;;) {
        let next = null
        for (const [id, timer] of timers) {
          if (timer.due <= target && (next === null || timer.due < next[1].due)) next = [id, timer]
        }
        if (next === null) break
        const [id, timer] = next
        now = Math.max(now, timer.due)
        if (timer.interval) timer.due += timer.interval
        else timers.delete(id)
        run(timer.fn, timer.args)
      }
      now = target
      const callbacks = frameCallbacks
      frameCallbacks = new Map()
      for (const callback of callbacks.values()) run(callback, [now])
      return { now, timers: timers.size, frames: frameCallbacks.size }
    },
    /** 取出并清空回调中的异常。 */
    errors() {
      return errors.splice(0)
    },
    touches(points) {
      if (!ensureLayer()) return
      while (markers.length < points.length) {
        const marker = document.createElement('div')
        marker.style.cssText =
          'position:absolute;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;' +
          'background:rgba(255,255,255,0.55);border:2px solid rgba(40,40,40,0.45);' +
          'box-shadow:0 1px 6px rgba(0,0,0,0.3);box-sizing:border-box'
        layer.appendChild(marker)
        markers.push(marker)
      }
      markers.forEach((marker, i) => {
        const point = points[i]
        marker.style.display = point ? 'block' : 'none'
        if (point) {
          marker.style.left = `${point.x}px`
          marker.style.top = `${point.y}px`
          marker.style.opacity = String(point.opacity ?? 1)
          marker.style.transform = `scale(${point.scale ?? 1})`
        }
      })
    },
  }
})()
