/** 内置默认配置与需求 10.2 一致，引用的机械臂资源随 APP 打包。 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import defaults from '../src/config/config.json' with { type: 'json' }
import { configSchema } from '../src/config/schema.ts'
import { readDoc, repoRoot, section } from './docs.ts'

const publicDir = path.join(repoRoot, 'app/public')

describe('默认配置 config.json', () => {
  it('通过校验', () => {
    expect(configSchema.safeParse(defaults).success).toBe(true)
  })

  it('与需求 10.2 一致；URDF 在服务端交付前使用开发用模型（app/public/robot/README.md）', () => {
    const block = /```json\n([\s\S]*?)```/.exec(section(readDoc('需求文档.md'), '10.2'))
    const documented = JSON.parse(block?.[1] ?? '{}') as typeof defaults
    expect(defaults).toEqual({
      ...documented,
      robot: { ...documented.robot, urdf: 'robot/aubo_i5H_dev.urdf' },
    })
  })

  it('URDF 和 package 映射的目录存在于 public/', () => {
    expect(existsSync(path.join(publicDir, defaults.robot.urdf))).toBe(true)
    for (const dir of Object.values(defaults.robot.packages)) {
      expect(existsSync(path.join(publicDir, dir)), dir).toBe(true)
    }
  })
})
