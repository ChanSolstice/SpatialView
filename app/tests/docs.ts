/** 按小节和表格读取 docs/ 下的文档，供"代码与文档一致"的测试使用。 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

export function readDoc(name: string): string {
  return readFileSync(path.join(repoRoot, 'docs', name), 'utf-8')
}

/** 编号为 number 的小节（如 "5.3"）的正文，到下一个同级或更高级的标题为止。 */
export function section(doc: string, number: string): string {
  const heading = new RegExp(`^(#{2,4}) ${number.replaceAll('.', '\\.')} .*$`, 'm').exec(doc)
  if (!heading?.[1]) throw new Error(`文档中没有第 ${number} 节`)
  const rest = doc.slice(heading.index + heading[0].length)
  const next = new RegExp(`^#{2,${heading[1].length}} `, 'm').exec(rest)
  return next ? rest.slice(0, next.index) : rest
}

export interface Table {
  header: string[]
  rows: string[][]
}

/** 文本中的全部 Markdown 表格。单元格去掉首尾空白，不含分隔行。 */
export function tables(text: string): Table[] {
  const result: Table[] = []
  let lines: string[][] = []
  const flush = () => {
    const [header, , ...rows] = lines
    if (header) result.push({ header, rows })
    lines = []
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      lines.push(
        trimmed
          .slice(1, -1)
          .split('|')
          .map((cell) => cell.trim()),
      )
    } else if (lines.length > 0) {
      flush()
    }
  }
  if (lines.length > 0) flush()
  return result
}

/** 小节中的第 index 个表格。 */
export function table(doc: string, number: string, index = 0): Table {
  const found = tables(section(doc, number))[index]
  if (!found) throw new Error(`第 ${number} 节没有第 ${index + 1} 个表格`)
  return found
}

/** 表格中某一列的值，按第一列为键。 */
export function column(t: Table, name: string): Map<string, string> {
  const at = t.header.indexOf(name)
  if (at < 0) throw new Error(`表格没有"${name}"列：${t.header.join('、')}`)
  return new Map(t.rows.map((row) => [row[0] ?? '', row[at] ?? '']))
}

/** 去掉 Markdown 的反引号。 */
export function code(cell: string): string {
  return cell.replace(/^`|`$/g, '')
}
