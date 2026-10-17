import type { PaginatedDoc } from '../types.js'
import { paginate } from '../viewer/text/textReader.js'
import { stripHtml } from '../utils/html.js'
import { t } from '../i18n/index.js'

function decodeMimeWord(word: string): string {
  const match = word.match(/=\?([^?]+)\?([bBqQ])\?([^?]+)\?=/g)
  if (!match) return word

  let res = word
  for (const m of match) {
    const sub = m.match(/=\?([^?]+)\?([bBqQ])\?([^?]+)\?/)
    if (!sub) continue
    const [, charset, enc, data] = sub
    try {
      if (enc.toUpperCase() === 'B') {
        const bin = atob(data)
        const bytes = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
        res = res.replace(m, new TextDecoder(charset as any).decode(bytes))
      } else if (enc.toUpperCase() === 'Q') {
        const decoded = data.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_, h) =>
          String.fromCharCode(parseInt(h, 16))
        )
        res = res.replace(m, decoded)
      }
    } catch { }
  }
  return res
}

export function parseEmlText(rawEml: string): PaginatedDoc {
  const normalized = rawEml.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const headBodySplit = normalized.indexOf('\n\n')

  const headerSection = headBodySplit !== -1 ? normalized.slice(0, headBodySplit) : normalized
  let bodySection = headBodySplit !== -1 ? normalized.slice(headBodySplit + 2) : ''

  const lines = headerSection.replace(/\n[ \t]+/g, ' ').split('\n')
  const headers: Record<string, string> = {}
  for (const l of lines) {
    const colon = l.indexOf(':')
    if (colon > 0) {
      const k = l.slice(0, colon).trim().toLowerCase()
      headers[k] = decodeMimeWord(l.slice(colon + 1).trim())
    }
  }

  const outHeaders: string[] = []
  const titleMap: Array<[string, string]> = [
    ['from', t('eml.from')],
    ['to', t('eml.to')],
    ['cc', t('eml.cc')],
    ['subject', t('eml.subject')],
    ['date', t('eml.date')],
  ]

  for (const [key, title] of titleMap) {
    if (headers[key]) outHeaders.push(`${title}: ${headers[key]}`)
  }

  const ct = headers['content-type'] || ''
  const boundaryMatch = ct.match(/boundary=["']?([^"';]+)["']?/i)
  if (boundaryMatch && boundaryMatch[1]) {
    const boundary = boundaryMatch[1]
    for (const part of bodySection.split(`--${boundary}`)) {
      if (part.startsWith('--') || !part.trim()) continue
      const partSplit = part.indexOf('\n\n')
      if (partSplit !== -1) {
        const partHead = part.slice(0, partSplit).toLowerCase()
        const partBody = part.slice(partSplit + 2)
        if (partHead.includes('text/plain')) {
          bodySection = partBody
          break
        }
        if (partHead.includes('text/html') && !bodySection) {
          bodySection = stripHtml(partBody)
        }
      }
    }
  } else if (ct.includes('text/html')) {
    bodySection = stripHtml(bodySection)
  }

  const fullText = (outHeaders.join('\n') + '\n\n' + bodySection.trim()).trim() || t('eml.emptyMessage')
  return {
    pages: paginate(fullText),
    font: 0,
    wrap: true,
  }
}