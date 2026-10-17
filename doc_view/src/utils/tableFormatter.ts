import { getLanguage } from '../i18n/index.js'

const CELL_MAX = 40
const NUM_RE = /^-?\d+([.,]\d+)?%?$/

export function fmtRows(rows: string[][], pad: boolean): string {
  const clean = rows.map((r) => r.map((c) => (c || '').replace(/\s+/g, ' ').trim()))
  if (!pad) return clean.map((r) => r.join(' │ ')).join('\n')

  const truncated = clean.map((r) =>
    r.map((c) => (c.length <= CELL_MAX ? c : c.slice(0, CELL_MAX - 1) + '…'))
  )

  const cols = truncated.reduce((max, r) => Math.max(max, r.length), 0)
  const widths = new Array(cols).fill(0)
  for (const r of truncated) {
    for (let i = 0; i < r.length; i++) widths[i] = Math.max(widths[i], r[i].length)
  }

  return truncated.map((r) => {
    const cells: string[] = []
    for (let i = 0; i < r.length; i++) {
      const c = r[i]
      cells.push(NUM_RE.test(c) ? c.padStart(widths[i], ' ') : c.padEnd(widths[i], ' '))
    }
    return cells.join(' │ ').trimEnd()
  }).join('\n')
}

export function trimRows(rows: string[][]): string[][] {
  const out = rows.map((r) => {
    const row = [...r]
    while (row.length > 0 && !row[row.length - 1]?.trim()) row.pop()
    return row
  })
  while (out.length > 0 && out[out.length - 1].length === 0) out.pop()
  return out
}

export function joinBlocks(blocks: Array<{ text: string; tight: boolean }>): string {
  const out: string[] = []
  let prevTight = false

  for (const b of blocks) {
    if (!b.text.trim()) continue
    if (out.length > 0) out.push(b.tight && prevTight ? '\n' : '\n\n')
    out.push(b.text)
    prevTight = b.tight
  }
  return out.join('')
}

export function formatBytes(n: number): string {
  const isRu = getLanguage() === 'ru'
  if (n <= 0) return isRu ? '0 Б' : '0 B'
  const units = isRu ? ['Б', 'КБ', 'МБ', 'ГБ'] : ['B', 'KB', 'MB', 'GB']
  let idx = 0
  let cur = n
  while (cur >= 1024 && idx < units.length - 1) {
    cur /= 1024
    idx++
  }
  return idx === 0 ? `${Math.round(cur)} ${units[idx]}` : `${cur.toFixed(1)} ${units[idx]}`
}

export function naturalSort(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
}