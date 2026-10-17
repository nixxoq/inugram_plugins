import { XMLParser } from 'fast-xml-parser'
import type { PaginatedDoc } from '../types.js'
import { paginate } from '../viewer/text/textReader.js'
import { joinBlocks } from '../utils/tableFormatter.js'
import { t } from '../i18n/index.js'

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  processEntities: false,
  removeNSPrefix: true,
  trimValues: false,
})

function fb2Inline(node: any): string {
  if (!node) return ''
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)

  const parts: string[] = []
  if (node['#text'] !== undefined) parts.push(String(node['#text']))

  for (const [k, v] of Object.entries(node)) {
    if (k.startsWith('@_')) continue
    if (Array.isArray(v)) {
      for (const item of v) parts.push(fb2Inline(item))
    } else if (typeof v === 'object') {
      parts.push(fb2Inline(v))
    }
  }

  return parts.join(' ').replace(/\s+/g, ' ').trim()
}

function fb2Walk(node: any, depth: number, out: Array<{ text: string; tight: boolean }>): void {
  if (!node || typeof node !== 'object') return

  if (Array.isArray(node)) {
    for (const item of node) fb2Walk(item, depth, out)
    return
  }

  for (const [k, v] of Object.entries(node)) {
    if (k.startsWith('@_')) continue
    if (k === 'title') {
      const s = fb2Inline(v)
      if (s) out.push({ text: `${'#'.repeat(Math.min(depth, 3))} ${s}`, tight: false })
    } else if (['p', 'subtitle', 'text-author'].includes(k)) {
      const list = Array.isArray(v) ? v : [v]
      for (const item of list) {
        const s = fb2Inline(item)
        if (s) out.push({ text: s, tight: false })
      }
    } else if (k === 'v') {
      const list = Array.isArray(v) ? v : [v]
      for (const item of list) {
        const s = fb2Inline(item)
        if (s) out.push({ text: s, tight: true })
      }
    } else if (['body', 'section', 'epigraph', 'cite', 'poem', 'stanza', 'annotation'].includes(k)) {
      fb2Walk(v, depth + (k === 'body' || k === 'section' ? 1 : 0), out)
    }
  }
}

export function parseFb2Xml(xml: string): PaginatedDoc {
  const root = xmlParser.parse(xml)?.FictionBook
  if (!root) return { pages: [t('books.emptyBook')], font: 1, wrap: true }

  const blocks: Array<{ text: string; tight: boolean }> = []
  const ti = root?.description?.['title-info']
  const bookTitle = fb2Inline(ti?.['book-title'])
  const authorNode = ti?.author
  let authorName = ''

  if (authorNode) {
    const a = Array.isArray(authorNode) ? authorNode[0] : authorNode
    authorName = [fb2Inline(a?.['first-name']), fb2Inline(a?.['last-name'])].filter(Boolean).join(' ')
  }

  const head = [authorName, bookTitle].filter(Boolean).join('\n')
  if (head) blocks.push({ text: head, tight: false })
  if (root.body) fb2Walk(root.body, 1, blocks)

  return {
    pages: paginate(joinBlocks(blocks) || t('books.emptyBook')),
    font: 1,
    wrap: true,
  }
}