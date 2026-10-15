// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { App } from './App.tsx'

afterEach(cleanup)

describe('App', () => {
  it('显示 APP 名称', () => {
    render(<App />)
    expect(screen.getByRole('heading', { name: 'SpatialView' })).toBeTruthy()
  })
})
