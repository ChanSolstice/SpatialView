/**
 * 按钮可用性（需求 5.3）：逐行核对需求文档中的表格，逐条覆盖 8 条全局规则；确认对话框（需求 5.4）；
 * 复位急停（需求 5.6）。规则 1（急停始终可按）不经过 availability，见 src/ros/commands.test.ts 和
 * src/ui/App.test.tsx 的"急停"。
 */
import { describe, expect, it } from 'vitest'
import {
  availability,
  confirmation,
  isActionAvailable,
  LABELS,
  type Availability,
  type AvailabilityInput,
  type ButtonView,
  type PanelButton,
} from '../src/domain/availability.ts'
import { PHASE_TEXT } from '../src/domain/phase.ts'
import type { CommandKey } from '../src/domain/types.ts'
import {
  LASER_STATES,
  PHASES,
  ROBOT_STATES,
  type Phase,
  type SystemState,
} from '../src/ros/contract.ts'
import { makeState, stateForPhase } from '../src/testing/fixtures.ts'
import { readDoc, table } from './docs.ts'

const requirements = readDoc('需求文档.md')

/** 表格的前提：已连接、设备都就绪、无指令在途、不在选面模式；模型和规划已加载。 */
function input(state: SystemState | null, overrides: Partial<AvailabilityInput> = {}) {
  return {
    connected: state !== null,
    state,
    interfaceOk: true,
    inflight: null,
    laserOffPending: false,
    mode: 'browse',
    selectionSize: 2,
    model: 'ready',
    plan: 'ready',
    animationReady: true,
    ...overrides,
  } satisfies AvailabilityInput
}

function at(phase: Phase, state: Partial<SystemState> = {}, rest: Partial<AvailabilityInput> = {}) {
  return availability(input(stateForPhase(phase, state), rest))
}

const PANEL: PanelButton[] = ['scan', 'select', 'plan', 'animate', 'main', 'stop', 'laser']
const COMMANDS: CommandKey[] = [
  'scan',
  'plan',
  'start',
  'pause',
  'resume',
  'stop',
  'laserOn',
  'resetEstop',
]

function enabled(result: Availability): PanelButton[] {
  return PANEL.filter((key) => result.buttons[key].enabled)
}

describe('需求 5.3 的表格', () => {
  const t = table(requirements, '5.3')
  const phaseOf = new Map(Object.entries(PHASE_TEXT).map(([phase, text]) => [text, phase as Phase]))
  const columns: [string, PanelButton][] = [
    ['开始扫描', 'scan'],
    ['选面', 'select'],
    ['开始规划', 'plan'],
    ['轨迹动画', 'animate'],
    ['停止', 'stop'],
    ['激光', 'laser'],
  ]

  it('表头与按钮栏一致，覆盖全部阶段', () => {
    expect(t.header).toEqual([
      '阶段',
      '开始扫描',
      '选面',
      '开始规划',
      '轨迹动画',
      '主按钮',
      '停止',
      '激光',
    ])
    expect(t.rows.map((row) => phaseOf.get(row[0] ?? ''))).toEqual([...PHASES])
  })

  function expectCell(view: ButtonView, cell: string, name: string, key: PanelButton) {
    const where = `${name}：${cell}`
    if (cell === '✓' || cell === '✓（需确认）') {
      expect(view.enabled, where).toBe(true)
      expect(view.label, where).toBe(key === 'laser' ? LABELS.laserOn : name)
      // 表格只为开始扫描、开始规划注明是否需要确认；其余按钮的确认规则见需求 5.4
      if (key === 'scan' || key === 'plan') expect(view.confirm, where).toBe(cell !== '✓')
    } else if (cell === '—') {
      expect(view.enabled, where).toBe(false)
      expect(view.variant, where).not.toBe('progress')
    } else {
      expect(cell, where).toMatch(/^正在.+…$/)
      expect(view.label, where).toBe(cell)
      expect(view.enabled, where).toBe(false)
      expect(view.variant, where).toBe('progress')
      expect(view.busy, where).toBe(true)
    }
  }

  it.each(t.rows)('%s', (phaseText, ...cells) => {
    const phase = phaseOf.get(phaseText) as Phase
    const { buttons } = at(phase)
    const cell = (name: string) => cells[t.header.indexOf(name) - 1] ?? ''
    for (const [name, key] of columns) expectCell(buttons[key], cell(name), name, key)

    const [label, mark] = cell('主按钮').split(' ')
    expect(buttons.main.label).toBe(label)
    expect(buttons.main.enabled).toBe(mark === '✓')
    expect(buttons.main.variant).toBe(mark === '✓' ? 'primary' : 'normal')
  })
})

describe('规则 2：关闭激光始终可用', () => {
  const notOff = LASER_STATES.filter((s) => s !== 'OFF')

  it.each(PHASES)('%s：激光不处于关闭状态时，任何设备状态、在途、版本、模式下都可用', (phase) => {
    for (const laser_state of [...notOff, 'SOMETHING_NEW']) {
      for (const robot_state of ROBOT_STATES) {
        for (const extra of [
          {},
          { inflight: 'scan' as const },
          { interfaceOk: false },
          { mode: 'select' as const },
          { mode: 'animate' as const },
          { model: 'loading' as const, plan: 'loading' as const },
        ]) {
          const { laser } = at(phase, { laser_state, robot_state }, extra).buttons
          expect(laser).toMatchObject({
            action: 'laserOff',
            label: '关闭激光',
            enabled: true,
            confirm: false,
            variant: 'warn',
          })
        }
      }
    }
  })

  it('已连接但还没有有效状态时（消息结构不匹配）也可以关闭', () => {
    const { laser } = availability(input(null, { connected: true, interfaceOk: false })).buttons
    expect(laser).toMatchObject({ action: 'laserOff', enabled: true })
  })

  it('激光关闭时显示开启激光', () => {
    expect(at('PLAN_READY').buttons.laser).toMatchObject({ action: 'laserOn', label: '开启激光' })
  })

  it('关闭激光的调用在途时显示转圈，仍然可以再按', () => {
    const { laser } = at('EXECUTING', { laser_state: 'ON' }, { laserOffPending: true }).buttons
    expect(laser).toMatchObject({ enabled: true, busy: true })
  })
})

describe('规则 3：未连接服务', () => {
  it('除急停外全部不可用，激光按钮显示开启激光', () => {
    const result = availability(input(null))
    expect(enabled(result)).toEqual([])
    expect(result.buttons.laser.label).toBe('开启激光')
    expect(result.reset.enabled).toBe(false)
  })

  it('保留的旧状态不影响：未连接时即使激光开启也不可用', () => {
    const last = stateForPhase('EXECUTING', { laser_state: 'ON', software_estop: true })
    const result = availability(input(last, { connected: false }))
    expect(enabled(result)).toEqual([])
    expect(result.reset.enabled).toBe(false)
  })
})

describe('规则 4：有指令在途', () => {
  it.each(COMMANDS)('%s 在途时，除关闭激光外全部不可用', (inflight) => {
    for (const phase of PHASES) {
      const result = at(phase, { laser_state: 'ON' }, { inflight })
      expect(enabled(result), phase).toEqual(['laser'])
      expect(result.buttons.laser.action).toBe('laserOff')
    }
  })

  it('被按下的按钮显示转圈，文字不变', () => {
    expect(at('NO_MODEL', {}, { inflight: 'scan' }).buttons.scan).toMatchObject({
      label: '开始扫描',
      busy: true,
      enabled: false,
    })
    expect(at('PLAN_READY', {}, { inflight: 'start' }).buttons.main).toMatchObject({
      label: '开始清洗',
      busy: true,
      variant: 'primary',
    })
    expect(at('EXECUTING', {}, { inflight: 'pause' }).buttons.main.busy).toBe(true)
    expect(at('PAUSED', {}, { inflight: 'resume' }).buttons.main.busy).toBe(true)
    expect(at('EXECUTING', {}, { inflight: 'stop' }).buttons.stop.busy).toBe(true)
    expect(at('MODEL_READY', {}, { inflight: 'plan' }).buttons.plan.busy).toBe(true)
    expect(at('NO_MODEL', {}, { inflight: 'laserOn' }).buttons.laser.busy).toBe(true)
    // 其他按钮不转圈
    const result = at('PLAN_READY', {}, { inflight: 'start' })
    expect(PANEL.filter((key) => result.buttons[key].busy)).toEqual(['main'])
  })
})

describe('规则 5：接口版本不匹配', () => {
  it.each(PHASES)('%s：除关闭激光外全部不可用', (phase) => {
    expect(enabled(at(phase, {}, { interfaceOk: false }))).toEqual([])
    expect(enabled(at(phase, { laser_state: 'ON' }, { interfaceOk: false }))).toEqual(['laser'])
  })

  it('阶段不认识时全部不可用，按钮显示默认文字', () => {
    const result = availability(input(makeState({ phase: 'CALIBRATING' })))
    expect(enabled(result)).toEqual([])
    expect(result.buttons.main.label).toBe('开始清洗')
    expect(result.buttons.scan.label).toBe('开始扫描')
  })
})

describe('规则 6：设备未就绪', () => {
  const ROBOT_BLOCKING = ['FAULT', 'ESTOP', 'DISABLED', 'OFFLINE']

  it('只有这四种机械臂状态算未就绪', () => {
    for (const robot_state of ROBOT_STATES) {
      const blocking = ROBOT_BLOCKING.includes(robot_state)
      expect(at('PLAN_READY', { robot_state }).buttons.scan.enabled, robot_state).toBe(!blocking)
    }
  })

  it.each(ROBOT_BLOCKING)(
    '机械臂%s：开始扫描、开始清洗、开启激光不可用，选面、规划、动画仍可用',
    (robot_state) => {
      expect(enabled(at('PLAN_READY', { robot_state }))).toEqual(['select', 'plan', 'animate'])
      expect(enabled(at('MODEL_READY', { robot_state }))).toEqual(['select', 'plan'])
      expect(enabled(at('NO_MODEL', { robot_state }))).toEqual([])
    },
  )

  it.each(ROBOT_BLOCKING)('机械臂%s：继续不可用，暂停和停止仍可用', (robot_state) => {
    expect(enabled(at('PAUSED', { robot_state }))).toEqual(['stop'])
    expect(enabled(at('EXECUTING', { robot_state }))).toEqual(['main', 'stop'])
  })

  it.each(['ERROR', 'OFFLINE'])('相机%s：只有开始扫描不可用', (camera_state) => {
    expect(enabled(at('PLAN_READY', { camera_state }))).toEqual([
      'select',
      'plan',
      'animate',
      'main',
      'laser',
    ])
    expect(enabled(at('NO_MODEL', { camera_state }))).toEqual(['laser'])
  })

  it.each(['ERROR', 'OFFLINE'])(
    '激光器%s：开始清洗、继续不可用，激光按钮变为关闭激光',
    (laser_state) => {
      const result = at('PLAN_READY', { laser_state })
      expect(enabled(result)).toEqual(['scan', 'select', 'plan', 'animate', 'laser'])
      expect(result.buttons.laser.action).toBe('laserOff')
      expect(enabled(at('PAUSED', { laser_state }))).toEqual(['stop', 'laser'])
      expect(enabled(at('EXECUTING', { laser_state }))).toEqual(['main', 'stop', 'laser'])
    },
  )
})

describe('规则 7：选面模式', () => {
  it.each(['MODEL_READY', 'PLAN_READY'] as const)(
    '%s：只有开始规划可用，选面显示为当前模式',
    (phase) => {
      const result = at(phase, {}, { mode: 'select' })
      expect(enabled(result)).toEqual(['plan'])
      expect(result.buttons.select).toMatchObject({ variant: 'active', enabled: false })
    },
  )

  it('激光开启时关闭激光仍可用', () => {
    expect(enabled(at('PLAN_READY', { laser_state: 'ON' }, { mode: 'select' }))).toEqual([
      'plan',
      'laser',
    ])
  })
})

describe('规则 8：本地加载中', () => {
  it('加载模型时，选面、开始规划、轨迹动画、开始清洗不可用', () => {
    expect(enabled(at('PLAN_READY', {}, { model: 'loading' }))).toEqual(['scan', 'laser'])
  })

  it('加载规划时，轨迹动画、开始清洗不可用', () => {
    expect(enabled(at('PLAN_READY', {}, { plan: 'loading' }))).toEqual([
      'scan',
      'select',
      'plan',
      'laser',
    ])
  })

  it('不影响暂停、继续、停止', () => {
    const loading = { model: 'loading', plan: 'loading' } as const
    expect(enabled(at('EXECUTING', {}, loading))).toEqual(['main', 'stop'])
    expect(enabled(at('PAUSED', {}, loading))).toEqual(['main', 'stop'])
  })
})

describe('轨迹动画', () => {
  it('动画模式中轨迹动画显示为当前模式，其他按钮与规划就绪相同', () => {
    const result = at('PLAN_READY', {}, { mode: 'animate' })
    expect(result.buttons.animate).toMatchObject({ variant: 'active', enabled: false })
    expect(enabled(result)).toEqual(['scan', 'select', 'plan', 'main', 'laser'])
  })

  it('规划数据与机械臂模型不匹配时不可用（需求 6.6）', () => {
    expect(at('PLAN_READY', {}, { animationReady: false }).buttons.animate.enabled).toBe(false)
  })
})

describe('需求 5.4 的确认', () => {
  it('开始扫描：已有模型时确认', () => {
    expect(at('NO_MODEL').buttons.scan.confirm).toBe(false)
    expect(at('MODEL_READY').buttons.scan.confirm).toBe(true)
    expect(at('PLAN_READY').buttons.scan.confirm).toBe(true)
  })

  it('开始规划：未选择表面，或已有规划时确认', () => {
    expect(at('MODEL_READY', {}, { selectionSize: 3 }).buttons.plan.confirm).toBe(false)
    expect(at('MODEL_READY', {}, { selectionSize: 0 }).buttons.plan.confirm).toBe(true)
    expect(at('PLAN_READY', {}, { selectionSize: 3 }).buttons.plan.confirm).toBe(true)
  })

  it('开始清洗、停止、开启激光每次确认；暂停、继续、关闭激光、选面、轨迹动画不确认', () => {
    expect(at('PLAN_READY').buttons.main.confirm).toBe(true)
    expect(at('EXECUTING').buttons.stop.confirm).toBe(true)
    expect(at('NO_MODEL').buttons.laser.confirm).toBe(true)
    expect(at('EXECUTING').buttons.main.confirm).toBe(false)
    expect(at('PAUSED').buttons.main.confirm).toBe(false)
    expect(at('EXECUTING', { laser_state: 'ON' }).buttons.laser.confirm).toBe(false)
    expect(at('PLAN_READY').buttons.select.confirm).toBe(false)
    expect(at('PLAN_READY').buttons.animate.confirm).toBe(false)
  })

  const texts = new Map(
    table(requirements, '5.4').rows.map(([operation = '', , text = '']) => [operation, text]),
  )

  it.each([
    ['开始扫描', 'scan'],
    ['开始清洗', 'start'],
    ['停止', 'stop'],
    ['开启激光', 'laserOn'],
    ['复位急停', 'resetEstop'],
  ] as const)('%s 的文案与需求一致', (operation, action) => {
    const dialog = confirmation(action, stateForPhase('PLAN_READY'), 2)
    expect(dialog.lines.join('')).toBe(texts.get(operation))
    expect(dialog.title).toBe(operation)
    expect(dialog.confirmLabel).toBe(operation)
  })

  it('开始规划按情况合并为一个对话框', () => {
    const doc = texts.get('开始规划') ?? ''
    const quoted = [...doc.matchAll(/"([^"]+)"/g)].map((m) => m[1])
    expect(quoted).toHaveLength(3)
    const [empty, replace, ask] = quoted
    expect(confirmation('plan', stateForPhase('MODEL_READY'), 0).lines).toEqual([empty, ask])
    expect(confirmation('plan', stateForPhase('PLAN_READY'), 2).lines).toEqual([replace, ask])
    expect(confirmation('plan', stateForPhase('PLAN_READY'), 0).lines).toEqual([
      empty,
      replace,
      ask,
    ])
  })
})

describe('需求 5.6 的复位急停', () => {
  const latched = { robot_state: 'ESTOP', software_estop: true }

  it('只在软件急停尚未复位时显示', () => {
    expect(at('PLAN_READY', latched).reset).toMatchObject({ visible: true, enabled: true })
    expect(at('PLAN_READY', { robot_state: 'ESTOP' }).reset.visible).toBe(false)
    expect(at('PLAN_READY').reset.visible).toBe(false)
  })

  it.each(PHASES)('%s', (phase) => {
    const interrupting = ['SCANNING', 'EXECUTING', 'PAUSED', 'STOPPING'].includes(phase)
    expect(at(phase, latched).reset.enabled).toBe(!interrupting)
  })

  it('受规则 3–5 限制，不受选面模式和加载限制', () => {
    expect(at('PLAN_READY', latched, { inflight: 'plan' }).reset.enabled).toBe(false)
    expect(at('PLAN_READY', latched, { interfaceOk: false }).reset.enabled).toBe(false)
    expect(
      availability(input(stateForPhase('PLAN_READY', latched), { connected: false })).reset,
    ).toMatchObject({ enabled: false })
    expect(at('PLAN_READY', latched, { mode: 'select' }).reset.enabled).toBe(true)
    expect(at('PLAN_READY', latched, { model: 'loading', plan: 'loading' }).reset.enabled).toBe(
      true,
    )
  })

  it('复位在途时转圈', () => {
    expect(at('PLAN_READY', latched, { inflight: 'resetEstop' }).reset).toMatchObject({
      enabled: false,
      busy: true,
    })
  })
})

describe('isActionAvailable', () => {
  it('按按钮当前的操作判断', () => {
    const result = at('PLAN_READY')
    expect(isActionAvailable('start', result)).toBe(true)
    expect(isActionAvailable('pause', result)).toBe(false)
    expect(isActionAvailable('laserOn', result)).toBe(true)
    expect(isActionAvailable('laserOff', result)).toBe(false)
    expect(isActionAvailable('resetEstop', result)).toBe(false)
    expect(
      isActionAvailable(
        'resetEstop',
        at('PLAN_READY', { robot_state: 'ESTOP', software_estop: true }),
      ),
    ).toBe(true)
  })
})
