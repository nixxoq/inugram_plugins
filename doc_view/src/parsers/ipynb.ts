import type { PaginatedDoc } from '../types.js'
import { paginate } from '../viewer/text/textReader.js'
import { t } from '../i18n/index.js'

const ANSI_REGEX = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g

export function parseIpynbText(jsonStr: string): PaginatedDoc {
  try {
    const nb = JSON.parse(jsonStr)
    let cells: any[] = nb.cells
    if (!cells && nb.worksheets) {
      cells = []
      for (const ws of nb.worksheets) {
        if (ws.cells) cells.push(...ws.cells)
      }
    }

    if (!cells || cells.length === 0) {
      return { pages: [t('ipynb.emptyNotebook')], font: 0, wrap: true }
    }

    const parts: string[] = []

    for (const c of cells) {
      const rawSrc = c.source ?? c.input ?? ''
      const src = Array.isArray(rawSrc) ? rawSrc.join('') : String(rawSrc)

      if (c.cell_type !== 'code') {
        if (src.trim()) parts.push(src.trim())
        continue
      }

      const block: string[] = [`In [${c.execution_count ?? ' '}]:\n${src}`]
      const outputs = Array.isArray(c.outputs) ? c.outputs : []

      for (const o of outputs) {
        let chunk = ''
        if (o.output_type === 'stream') {
          chunk = Array.isArray(o.text) ? o.text.join('') : String(o.text || '')
        } else if (o.output_type === 'error') {
          const tb = Array.isArray(o.traceback) ? o.traceback.join('\n') : String(o.traceback || '')
          chunk = tb.replace(ANSI_REGEX, '')
        } else {
          const data = o.data || {}
          chunk = data['text/plain']
            ? (Array.isArray(data['text/plain']) ? data['text/plain'].join('') : String(data['text/plain']))
            : ''
          if (!chunk && Object.keys(data).some((k) => k.startsWith('image/'))) {
            chunk = t('ipynb.imagePlaceholder')
          }
        }

        if (chunk.trim()) block.push(`Out:\n${chunk.trim()}`)
      }

      parts.push(block.join('\n\n'))
    }

    const separator = '\n\n' + '─'.repeat(28) + '\n\n'
    return {
      pages: paginate(parts.join(separator) || t('ipynb.emptyNotebook')),
      font: 0,
      wrap: true,
    }
  } catch (err: any) {
    return {
      pages: [t('ipynb.parseError', { error: err?.message || err })],
      font: 0,
      wrap: true,
    }
  }
}