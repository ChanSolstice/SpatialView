// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OVERRIDE_KEY } from '../../config/load.ts'
import type { Runtime } from '../../runtime.ts'
import { testRuntime } from '../../testing/runtime.ts'
import { RuntimeContext } from '../runtimeContext.ts'
import EngineeringEntry from './EngineeringEntry.tsx'
import { EngineeringPanel } from './EngineeringPanel.tsx'

let runtime: Runtime

beforeEach(async () => {
  ;({ runtime } = await testRuntime())
})

afterEach(() => {
  cleanup()
  runtime.dispose()
  vi.useRealTimers()
})

describe('工程入口（需求 10.3）', () => {
  const renderEntry = (verify: (p: string) => Promise<boolean>) =>
    render(
      <RuntimeContext.Provider value={runtime}>
        <EngineeringEntry verify={verify}>
          <div>SpatialView</div>
        </EngineeringEntry>
      </RuntimeContext.Provider>,
    )

  it('长按 5 秒弹出密码框；不到 5 秒松开没有反应', () => {
    vi.useFakeTimers()
    renderEntry(async () => false)
    const brand = screen.getByText('SpatialView')
    fireEvent.pointerDown(brand)
    act(() => vi.advanceTimersByTime(4900))
    fireEvent.pointerUp(brand)
    act(() => vi.advanceTimersByTime(1000))
    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.pointerDown(brand)
    act(() => vi.advanceTimersByTime(5000))
    expect(screen.getByRole('dialog', { name: '工程入口' })).toBeTruthy()
  })

  it('密码错误时提示并清空；正确后打开工程面板，返回后关闭', async () => {
    vi.useFakeTimers()
    renderEntry(async (p) => p === '2468')
    fireEvent.pointerDown(screen.getByText('SpatialView'))
    act(() => vi.advanceTimersByTime(5000))
    vi.useRealTimers()
    const input = screen.getByLabelText('密码') as HTMLInputElement
    fireEvent.change(input, { target: { value: '1111' } })
    fireEvent.click(screen.getByRole('button', { name: '确定' }))
    expect(await screen.findByText('密码错误')).toBeTruthy()
    expect(input.value).toBe('')
    fireEvent.change(input, { target: { value: '2468' } })
    fireEvent.click(screen.getByRole('button', { name: '确定' }))
    expect(await screen.findByTestId('engineering-panel')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '返回' }))
    expect(screen.queryByTestId('engineering-panel')).toBeNull()
  })
})

describe('工程面板（需求 10.3；前端UI设计 4.7）', () => {
  const renderPanel = (reload = vi.fn(), value: Runtime = runtime) => {
    render(
      <RuntimeContext.Provider value={value}>
        <EngineeringPanel onClose={() => {}} reload={reload} />
      </RuntimeContext.Provider>,
    )
    return reload
  }
  const json = () => (screen.getByLabelText('完整配置（JSON）') as HTMLTextAreaElement).value

  it('常用项表单与 JSON 编辑同步；保存只写入改过的字段，然后按新配置重新加载', async () => {
    const reload = renderPanel()
    fireEvent.change(screen.getByLabelText('ROSbridge 地址'), {
      target: { value: 'ws://10.0.0.8:9090' },
    })
    expect(JSON.parse(json()).server.rosbridge_url).toBe('ws://10.0.0.8:9090')
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await vi.waitFor(() => expect(reload).toHaveBeenCalled())
    const saved = JSON.parse((await runtime.preferences.get(OVERRIDE_KEY)) ?? 'null')
    expect(saved.server).toEqual({ rosbridge_url: 'ws://10.0.0.8:9090' })
    expect(saved.config_version).toBe(1)
  })

  it('保存前检查：JSON 无效或字段不合法时提示，不保存', async () => {
    const reload = renderPanel()
    fireEvent.change(screen.getByLabelText('完整配置（JSON）'), { target: { value: '{ oops' } })
    expect(screen.getByText('不是有效的 JSON，上面的表单暂时不能编辑')).toBeTruthy()
    expect((screen.getByLabelText('HTTP 地址') as HTMLInputElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByText(/不是有效的 JSON：/)).toBeTruthy()

    const config = JSON.parse(JSON.stringify(runtime.config.config))
    config.server.http_base_url = 'ftp://x'
    fireEvent.change(screen.getByLabelText('完整配置（JSON）'), {
      target: { value: JSON.stringify(config) },
    })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByText(/http:\/\//)).toBeTruthy()
    expect(reload).not.toHaveBeenCalled()
    expect(await runtime.preferences.get(OVERRIDE_KEY)).toBeNull()
  })

  it('恢复默认删除覆盖配置；版本信息；配置版本不一致时提示', async () => {
    await runtime.preferences.set(OVERRIDE_KEY, '{"config_version":0}')
    const reload = renderPanel(vi.fn(), {
      ...runtime,
      config: { ...runtime.config, overrideVersion: 0 },
    })
    expect(screen.getByText(/覆盖配置保存于配置版本 0，当前默认配置版本为 1/)).toBeTruthy()
    const foot = screen.getByTestId('engineering-panel').querySelector('.eng-foot')?.textContent
    expect(foot).toContain('期望接口版本 1.0')
    expect(foot).toContain('默认配置版本 1')
    expect(foot).toContain('覆盖配置版本 0')
    fireEvent.click(screen.getByRole('button', { name: '恢复默认' }))
    await vi.waitFor(() => expect(reload).toHaveBeenCalled())
    expect(await runtime.preferences.get(OVERRIDE_KEY)).toBeNull()
  })
})
