import { Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import { WORKPIECE_MATERIALS } from '../assets/materials.ts'
import { defaultCameraPosition, fitDistance } from './camera.ts'
import { materialFor } from './materialFor.ts'

describe('fitDistance', () => {
  it('包围球与较窄方向的视场相切，留 5% 的边', () => {
    // 宽屏时由垂直视场决定
    const d = fitDistance(1, 38, 980 / 736)
    expect(Math.asin(1 / (d / 1.05)) * 2 * (180 / Math.PI)).toBeCloseTo(38, 6)
    // 竖屏时由水平视场决定，距离更远
    expect(fitDistance(1, 38, 0.5)).toBeGreaterThan(d)
  })

  it('与半径成正比', () => {
    expect(fitDistance(2, 38, 1.3)).toBeCloseTo(2 * fitDistance(1, 38, 1.3), 9)
  })
})

describe('defaultCameraPosition', () => {
  it('从观察中心沿配置的方向退到给定距离', () => {
    const target = new Vector3(0.5, 0, 0.2)
    const position = defaultCameraPosition(target, [1, -1, 0.8], 2)
    expect(position.distanceTo(target)).toBeCloseTo(2, 9)
    const direction = position.clone().sub(target).normalize()
    expect(direction.toArray().map((v) => +v.toFixed(4))).toEqual(
      new Vector3(1, -1, 0.8)
        .normalize()
        .toArray()
        .map((v) => +v.toFixed(4)),
    )
  })
})

describe('materialFor', () => {
  it('浏览时都用默认材质，不可处理的表面也一样', () => {
    expect(materialFor('normal', false, false)).toBe(WORKPIECE_MATERIALS.normal)
    expect(materialFor('normal', true, true)).toBe(WORKPIECE_MATERIALS.normal)
  })

  it('扫描、重建期间淡化', () => {
    expect(materialFor('faded', true, true)).toBe(WORKPIECE_MATERIALS.faded)
  })

  it('选面模式：选中为橙色，不可处理为深灰色', () => {
    expect(materialFor('selectable', true, true)).toBe(WORKPIECE_MATERIALS.selected)
    expect(materialFor('selectable', true, false)).toBe(WORKPIECE_MATERIALS.normal)
    expect(materialFor('selectable', false, true)).toBe(WORKPIECE_MATERIALS.unselectable)
  })
})
