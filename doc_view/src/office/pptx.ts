import { XMLParser } from 'fast-xml-parser'
import type { PaginatedDoc } from '../types.js'
import { naturalSort } from '../utils/tableFormatter.js'
import { listZipEntries, readZipEntryText } from '../archive/zip/helper.js'
import { t } from '../i18n/index.js'

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  processEntities: false,
  removeNSPrefix: true,
  trimValues: false,
})

function extractText(node: any): string {
  if (!node) return ''
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  return node['#text'] !== undefined ? String(node['#text']) : ''
}

function parsePptxPara(p: any): string {
  const parts: string[] = []
  function walk(n: any): void {
    if (!n || typeof n !== 'object') return
    for (const [k, v] of Object.entries(n)) {
      if (k.startsWith('@_')) continue
      if (k === 't') {
        if (Array.isArray(v)) for (const item of v) parts.push(extractText(item))
        else parts.push(extractText(v))
      } else if (k === 'br') {
        parts.push('\n')
      } else if (Array.isArray(v)) {
        for (const child of v) walk(child)
      } else if (typeof v === 'object') {
        walk(v)
      }
    }
  }
  walk(p)
  return parts.join('').trim()
}

function findPptxSlideOrder(filePath: string): string[] {
  const { entries } = listZipEntries(filePath, 300)
  const entryNames = entries.map((e) => e.name)

  const presXml = readZipEntryText(filePath, 'ppt/presentation.xml')
  const relsXml = readZipEntryText(filePath, 'ppt/_rels/presentation.xml.rels')

  if (presXml && relsXml) {
    try {
      const pres = xmlParser.parse(presXml)
      const rels = xmlParser.parse(relsXml)

      const relMap: Record<string, string> = {}
      const relList = Array.isArray(rels?.Relationships?.Relationship)
        ? rels.Relationships.Relationship
        : rels?.Relationships?.Relationship
          ? [rels.Relationships.Relationship]
          : []

      for (const r of relList) {
        const id = String(r?.['@_Id'] || '')
        let target = String(r?.['@_Target'] || '')
        if (!target.startsWith('ppt/')) target = `ppt/${target}`
        relMap[id] = target
      }

      const sldIdList = pres?.presentation?.sldIdLst?.sldId
      const list = Array.isArray(sldIdList) ? sldIdList : sldIdList ? [sldIdList] : []
      const order: string[] = []

      for (const s of list) {
        const target = relMap[String(s?.['@_r:id'] || s?.['@_id'] || '')]
        if (target && entryNames.includes(target)) order.push(target)
      }

      if (order.length > 0) return order
    } catch { }
  }

  return entryNames.filter((n) => /^ppt\/slides\/slide\d+\.xml$/i.test(n)).sort(naturalSort)
}

export async function parsePptxDocument(filePath: string): Promise<PaginatedDoc> {
  const slides = findPptxSlideOrder(filePath)
  if (slides.length === 0) {
    return { pages: [t('office.emptyPresentation')], font: 0, wrap: true }
  }

  const pages: string[] = []

  for (let i = 0; i < slides.length; i++) {
    const slideXml = readZipEntryText(filePath, slides[i])
    if (!slideXml) continue

    const parsed = xmlParser.parse(slideXml)
    const paras: string[] = []

    function findParas(node: any): void {
      if (!node || typeof node !== 'object') return
      for (const [k, v] of Object.entries(node)) {
        if (k.startsWith('@_')) continue
        if (k === 'p') {
          const list = Array.isArray(v) ? v : [v]
          for (const item of list) {
            const str = parsePptxPara(item)
            if (str) paras.push(str)
          }
        } else if (Array.isArray(v)) {
          for (const child of v) findParas(child)
        } else if (typeof v === 'object') {
          findParas(v)
        }
      }
    }

    findParas(parsed)
    const body = paras.length > 0 ? paras.join('\n\n') : t('office.noText')
    pages.push(`${t('office.slideHeader', { index: i + 1 })}\n\n${body}`)
  }

  return {
    pages: pages.length > 0 ? pages : [t('office.emptyPresentation')],
    font: 0,
    wrap: true,
  }
}