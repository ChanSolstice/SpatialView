/** 网页版的说明（app/web/README.md）中的压缩包名和解压目录与 APP 版本一致（scripts/build-web.sh 按版本命名）。 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { repoRoot } from './docs.ts'

const read = (file: string) => readFileSync(path.join(repoRoot, file), 'utf-8')

describe('网页版说明', () => {
  it('压缩包名和解压目录中的版本号与 package.json 一致', () => {
    const { version } = JSON.parse(read('app/package.json')) as { version: string }
    const versions = [
      ...read('app/web/README.md').matchAll(/spatialview-web-(\d+\.\d+\.\d+)/g),
    ].map((match) => match[1])
    expect(versions.length).toBeGreaterThan(0)
    expect(new Set(versions)).toEqual(new Set([version]))
  })
})
