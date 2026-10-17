import { XMLParser } from 'fast-xml-parser'
import type { PaginatedDoc } from '../types.js'
import { paginate } from '../viewer/text/textReader.js'
import { listZipEntries, readZipEntryText } from '../archive/zip/helper.js'
import { stripHtml } from '../utils/html.js'
import { t } from '../i18n/index.js'

export async function parseEpubDocument(filePath: string): Promise<PaginatedDoc> {
  const containerXml = readZipEntryText(filePath, 'META-INF/container.xml')
  if (!containerXml) throw new Error(t('books.containerNotFound'))

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    processEntities: false,
    removeNSPrefix: true,
  })

  const container = parser.parse(containerXml)
  const rootfiles = container?.container?.rootfiles?.rootfile
  const rf = Array.isArray(rootfiles) ? rootfiles[0] : rootfiles
  const opfPath = String(rf?.['@_full-path'] || '')
  if (!opfPath) throw new Error(t('books.fullPathNotFound'))

  const opfXml = readZipEntryText(filePath, opfPath)
  if (!opfXml) throw new Error(t('books.packageFileNotFound', { path: opfPath }))

  const opf = parser.parse(opfXml)
  const baseDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : ''

  const manifestMap: Record<string, string> = {}
  const items = opf?.package?.manifest?.item
  const itemList = Array.isArray(items) ? items : items ? [items] : []
  for (const it of itemList) {
    const id = String(it?.['@_id'] || '')
    const href = String(it?.['@_href'] || '')
    if (id && href) manifestMap[id] = href
  }

  const spineItems = opf?.package?.spine?.itemref
  const spineList = Array.isArray(spineItems) ? spineItems : spineItems ? [spineItems] : []

  const { entries } = listZipEntries(filePath, 500)
  const entryNames = new Set(entries.map((e) => e.name))
  const pages: string[] = []

  for (const ref of spineList) {
    const href = manifestMap[String(ref?.['@_idref'] || '')]
    if (!href) continue

    const cleanHref = decodeURIComponent(href.split('#')[0])
    let fullHref = baseDir + cleanHref
    if (!entryNames.has(fullHref) && fullHref.startsWith('/')) {
      fullHref = fullHref.slice(1)
    }

    if (!entryNames.has(fullHref)) {
      const parts = (baseDir + cleanHref).split('/')
      const resolved: string[] = []
      for (const p of parts) {
        if (p === '..') resolved.pop()
        else if (p !== '.' && p) resolved.push(p)
      }
      fullHref = resolved.join('/')
    }

    const chapterHtml = readZipEntryText(filePath, fullHref)
    if (!chapterHtml) continue

    const text = stripHtml(chapterHtml)
    if (text) pages.push(...paginate(text))
  }

  return {
    pages: pages.length > 0 ? pages : [t('books.noTextInBook')],
    font: 1,
    wrap: true,
  }
}