/**
 * 接口约定一致性检查（阶段规划阶段 3）：src/ros/contract.ts、spatialview_msgs 的 .msg/.srv、
 * 接口文档第 7 节三者必须一致。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as contract from '../src/ros/contract.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const msgDir = path.join(root, 'ros2_ws/src/spatialview_msgs')
const interfaceDoc = readFileSync(path.join(root, 'docs/服务端对接接口文档.md'), 'utf-8')

function read(file: string): string {
  return readFileSync(path.join(msgDir, file), 'utf-8')
}

/** 解析 `string NAME="VALUE"` 形式的常量，保持顺序。 */
function constants(text: string): [string, string][] {
  return [...text.matchAll(/^\s*string\s+([A-Z][A-Z0-9_]*)\s*=\s*"([^"]*)"/gm)].map((m) => [
    m[1] as string,
    m[2] as string,
  ])
}

function values(text: string, prefix: string): string[] {
  return constants(text)
    .filter(([name]) => name.startsWith(prefix))
    .map(([, value]) => value)
}

/** 解析字段名（不含常量和注释），保持顺序。 */
function fields(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.replace(/#.*/, '').trim())
    .filter((line) => line && !line.includes('='))
    .map((line) => line.split(/\s+/)[1] as string)
}

/** .srv 拆成请求和响应两部分。 */
function srv(file: string): { request: string; response: string } {
  const [request = '', response = ''] = read(file).split(/^---$/m)
  return { request, response }
}

/** 接口文档某一小节表格第一列中用反引号括起的码。 */
function documentedCodes(section: string): string[] {
  const start = interfaceDoc.indexOf(`### ${section} `)
  const end = interfaceDoc.indexOf('\n### ', start + 1)
  const text = interfaceDoc.slice(start, end)
  return [...text.matchAll(/^\|\s*`([A-Z_]+)`\s*\|/gm)].map((m) => m[1] as string)
}

describe('SystemState.msg', () => {
  const text = read('msg/SystemState.msg')

  it('接口版本一致', () => {
    expect(values(text, 'INTERFACE_VERSION')).toEqual([contract.INTERFACE_VERSION])
  })

  it('枚举取值一致', () => {
    expect(values(text, 'ROBOT_')).toEqual([...contract.ROBOT_STATES])
    expect(values(text, 'CAMERA_')).toEqual([...contract.CAMERA_STATES])
    expect(values(text, 'LASER_')).toEqual([...contract.LASER_STATES])
    expect(values(text, 'PHASE_')).toEqual([...contract.PHASES])
  })

  it('字段一致', () => {
    expect(fields(text)).toEqual(Object.keys(contract.systemStateSchema.shape))
  })
})

describe('Alarm.msg、OperationResult.msg', () => {
  it('取值和字段一致', () => {
    const alarm = read('msg/Alarm.msg')
    expect(values(alarm, 'LEVEL_')).toEqual([...contract.ALARM_LEVELS])
    expect(fields(alarm)).toEqual(Object.keys(contract.alarmSchema.shape))

    const result = read('msg/OperationResult.msg')
    expect(values(result, 'OPERATION_')).toEqual([...contract.OPERATIONS])
    expect(values(result, 'RESULT_')).toEqual([...contract.RESULTS])
    expect(fields(result)).toEqual(Object.keys(contract.operationResultSchema.shape))
  })
})

describe('StatusCode.msg', () => {
  const codes = constants(read('msg/StatusCode.msg'))

  it('常量名与取值相同', () => {
    for (const [name, value] of codes) expect(value).toBe(name)
  })

  it('包含 contract.ts 中的全部状态码，且没有多余', () => {
    const all = new Set([
      ...contract.COMMAND_CODES,
      ...contract.RESULT_CODES,
      ...contract.ALARM_CODES,
    ])
    expect(new Set(codes.map(([name]) => name))).toEqual(all)
  })
})

describe('接口文档第 7 节', () => {
  it('7.1 指令状态码', () => {
    expect(documentedCodes('7.1')).toEqual([...contract.COMMAND_CODES])
  })

  it('7.2 操作结果原因码', () => {
    expect(documentedCodes('7.2')).toEqual([...contract.RESULT_CODES])
  })

  it('7.3 告警码', () => {
    expect(documentedCodes('7.3')).toEqual([...contract.ALARM_CODES])
  })
})

describe('Service', () => {
  const entries = Object.entries(contract.SERVICES) as [
    keyof typeof contract.SERVICES,
    (typeof contract.SERVICES)[keyof typeof contract.SERVICES],
  ][]

  it.each(entries)('%s 的请求和响应字段与 .srv 一致', (key, service) => {
    expect(service.name.startsWith('/spatialview/')).toBe(true)
    const name = service.type.replace('spatialview_msgs/srv/', '')
    const { request, response } = srv(`srv/${name}.srv`)
    expect(fields(request)).toEqual([...contract.REQUEST_FIELDS[key]])
    const expected =
      key === 'getSystemState'
        ? Object.keys(contract.getSystemStateResponseSchema.shape)
        : Object.keys(contract.commandResponseSchema.shape)
    expect(fields(response)).toEqual(expected)
  })

  it('TaskControl 的命令取值一致', () => {
    expect(values(srv('srv/TaskControl.srv').request, 'COMMAND_')).toEqual([
      ...contract.TASK_COMMANDS,
    ])
  })

  it('StartScan 的工件类型取值一致', () => {
    expect(values(srv('srv/StartScan.srv').request, 'WORKPIECE_TYPE_')).toEqual([
      ...contract.WORKPIECE_TYPES,
    ])
  })
})

describe('接口文档附录 A 的报文', () => {
  it('收到的状态符合 SystemState 的校验规则', () => {
    const start = interfaceDoc.indexOf('收到的状态：')
    const block = interfaceDoc.slice(start).match(/```json\n([\s\S]*?)```/)
    const message = JSON.parse(block?.[1] ?? '{}') as { msg: unknown }
    const state = contract.systemStateSchema.parse(message.msg)
    expect(state.interface_version).toBe(contract.INTERFACE_VERSION)
  })
})
