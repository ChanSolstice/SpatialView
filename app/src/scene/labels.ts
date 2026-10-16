/**
 * 场景内的文字标签（前端UI设计第 5 节）：three.js 的 CSS2DRenderer，与静态原型相同。
 * 标签是叠在画布上的 DOM 元素，跟随三维点的屏幕位置，不接收触摸。
 */
import { Group, type Vector3 } from 'three'
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js'

export interface PathLabels {
  group: Group
  start: CSS2DObject
  end: CSS2DObject
}

/** CSS2DRenderer 会改写元素的 transform，标签的上移放在内层元素上。 */
function label(text: string, kind: 'start' | 'end'): CSS2DObject {
  const outer = document.createElement('div')
  const inner = document.createElement('span')
  inner.className = `path-label path-label-${kind}`
  inner.textContent = text
  outer.append(inner)
  return new CSS2DObject(outer)
}

export function createPathLabels(): PathLabels {
  const start = label('起点', 'start')
  const end = label('终点', 'end')
  const group = new Group()
  group.name = 'path-labels'
  group.add(start, end)
  return { group, start, end }
}

export function placePathLabels(labels: PathLabels, start: Vector3, end: Vector3): void {
  labels.start.position.copy(start)
  labels.end.position.copy(end)
}

/** CSS2DRenderer 只看标签自身的 visible，不看上层对象，显示和隐藏都设置在标签上。 */
export function showPathLabels(labels: PathLabels, visible: boolean): void {
  labels.start.visible = visible
  labels.end.visible = visible
}
