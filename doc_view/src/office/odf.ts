import { XMLParser } from 'fast-xml-parser'
import type { PaginatedDoc } from '../types.js'
import { paginate } from '../viewer/text/textReader.js'
import { fmtRows, joinBlocks, trimRows } from '../utils/tableFormatter.js'
import { readZipEntryText, readZipEntryBase64 } from '../archive/zip/helper.js'
import { escapeHtml } from '../utils/html.js'
import { renderOfficeHtmlShell } from './render.js'
import { t } from '../i18n/index.js'

const MAX_ROWS = 500
const MAX_COLS = 40

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  trimValues: false,
})

interface OdfStyle {
  bold?: boolean
  italic?: boolean
  underline?: boolean
  color?: string
  fontSize?: string
  fontFamily?: string
  textAlign?: string
  textIndent?: string
  marginTop?: string
  marginBottom?: string
}

function parseOdfStyles(xml: string | null): Map<string, OdfStyle> {
  const styles = new Map<string, OdfStyle>()
  if (!xml) return styles

  try {
    const parsed = xmlParser.parse(xml)
    const findStyles = (obj: any) => {
      if (!obj || typeof obj !== 'object') return
      for (const [k, v] of Object.entries(obj)) {
        if (k === 'style' || k === 'default-style') {
          const list = Array.isArray(v) ? v : [v]
          for (const s of list) {
            const name = s['@_name'] || s['@_family']
            if (!name) continue
            const st: OdfStyle = {}
            const tp = s['text-properties']
            if (tp) {
              if (tp['@_font-weight'] === 'bold' || tp['@_font-weight-asian'] === 'bold') st.bold = true
              if (tp['@_font-style'] === 'italic' || tp['@_font-style-asian'] === 'italic') st.italic = true
              if (tp['@_text-underline-style'] && tp['@_text-underline-style'] !== 'none') st.underline = true
              if (tp['@_color']) st.color = tp['@_color']
              if (tp['@_font-size']) st.fontSize = tp['@_font-size']
              if (tp['@_font-name'] || tp['@_font-family']) st.fontFamily = tp['@_font-name'] || tp['@_font-family']
            }
            const pp = s['paragraph-properties']
            if (pp) {
              if (pp['@_text-align']) {
                const a = pp['@_text-align']
                st.textAlign = a === 'start' ? 'left' : a === 'end' ? 'right' : a
              }
              if (pp['@_text-indent']) st.textIndent = pp['@_text-indent']
              if (pp['@_margin-top']) st.marginTop = pp['@_margin-top']
              if (pp['@_margin-bottom']) st.marginBottom = pp['@_margin-bottom']
            }
            styles.set(name, st)
          }
        } else if (typeof v === 'object') {
          findStyles(v)
        }
      }
    }
    findStyles(parsed)
  } catch { }

  return styles
}

export function buildOdfHtml(filePath: string, theme: { bg: string; fg: string; alt: string }): string {
  const contentXml = readZipEntryText(filePath, 'content.xml')
  if (!contentXml) throw new Error(t('office.odfContentNotFound'))

  const stylesMap = parseOdfStyles(readZipEntryText(filePath, 'styles.xml'))
  const contentStyles = parseOdfStyles(contentXml)
  for (const [k, v] of contentStyles.entries()) {
    stylesMap.set(k, { ...(stylesMap.get(k) || {}), ...v })
  }

  const body = xmlParser.parse(contentXml)?.['document-content']?.body || xmlParser.parse(contentXml)?.body
  if (!body) return `<div>${t('office.emptyDoc')}</div>`

  const htmlChunks: string[] = []

  function renderInline(node: any): string {
    if (!node) return ''
    if (typeof node === 'string') return escapeHtml(node)
    if (typeof node === 'number') return String(node)

    const parts: string[] = []
    if (node['#text'] !== undefined) parts.push(escapeHtml(String(node['#text'])))

    for (const [k, v] of Object.entries(node)) {
      if (k.startsWith('@_')) continue
      if (k === 's') {
        const count = parseInt(String((v as any)?.['@_c'] || '1'), 10)
        parts.push('\u00A0'.repeat(Math.min(count, 50)))
      } else if (k === 'tab') {
        parts.push('<span style="display:inline-block;min-width:2em">&emsp;</span>')
      } else if (k === 'line-break') {
        parts.push('<br>')
      } else if (k === 'span') {
        const list = Array.isArray(v) ? v : [v]
        for (const item of list) {
          const st = (item as any)?.['@_style-name'] ? stylesMap.get((item as any)['@_style-name']) : null
          let text = renderInline(item)
          if (st) {
            const css: string[] = []
            if (st.bold) text = `<strong>${text}</strong>`
            if (st.italic) text = `<em>${text}</em>`
            if (st.underline) text = `<u>${text}</u>`
            if (st.color) css.push(`color: ${st.color}`)
            if (st.fontSize) css.push(`font-size: ${st.fontSize}`)
            if (st.fontFamily) css.push(`font-family: '${st.fontFamily}', serif`)
            if (css.length > 0) text = `<span style="${css.join('; ')}">${text}</span>`
          }
          parts.push(text)
        }
      } else if (k === 'a') {
        const list = Array.isArray(v) ? v : [v]
        for (const item of list) {
          const href = (item as any)?.['@_href'] || '#'
          const safeHref = href.startsWith('http') || href.startsWith('mailto') ? escapeHtml(href) : '#'
          parts.push(`<a href="${safeHref}" target="_blank">${renderInline(item)}</a>`)
        }
      } else if (k === 'frame' || k === 'image') {
        const list = Array.isArray(v) ? v : [v]
        for (const f of list) {
          const href = (f.image || f)?.['@_href']
          if (href && !href.startsWith('http')) {
            const cleanPath = href.replace(/^\//, '')
            const b64 = readZipEntryBase64(filePath, cleanPath)
            if (b64) parts.push(`<img src="data:image/png;base64,${b64}" style="max-width:100%;height:auto;margin:6px 0;" alt="Image" />`)
          }
        }
      } else if (typeof v === 'object') {
        parts.push(renderInline(v))
      }
    }

    return parts.join('')
  }

  function renderParagraph(p: any, tag = 'p'): string {
    const st = p?.['@_style-name'] ? stylesMap.get(p['@_style-name']) : null
    const inner = renderInline(p)
    if (!inner.trim()) return `<${tag} class="odf-p"></${tag}>`

    const css: string[] = []
    if (st) {
      if (st.textAlign) css.push(`text-align: ${st.textAlign}`)
      if (st.textIndent) css.push(`text-indent: ${st.textIndent}`)
      if (st.marginTop) css.push(`margin-top: ${st.marginTop}`)
      if (st.marginBottom) css.push(`margin-bottom: ${st.marginBottom}`)
      if (st.fontSize) css.push(`font-size: ${st.fontSize}`)
      if (st.color) css.push(`color: ${st.color}`)
    }

    const styleStr = css.length > 0 ? ` style="${css.join('; ')}"` : ''
    return `<${tag} class="odf-p"${styleStr}>${inner}</${tag}>`
  }

  function renderList(listNode: any, ordered = false): string {
    const tag = ordered ? 'ol' : 'ul'
    const items = Array.isArray(listNode?.['list-item'])
      ? listNode['list-item']
      : listNode?.['list-item']
        ? [listNode['list-item']]
        : []

    const itemsHtml: string[] = []
    for (const item of items) {
      const innerParts: string[] = []
      if (item && typeof item === 'object') {
        for (const [k, v] of Object.entries(item)) {
          if (k === 'p' || k === 'h') {
            const list = Array.isArray(v) ? v : [v]
            for (const el of list) innerParts.push(renderInline(el))
          } else if (k === 'list') {
            innerParts.push(renderList(v, ordered))
          }
        }
      }
      if (innerParts.length > 0) itemsHtml.push(`<li>${innerParts.join('<br>')}</li>`)
    }

    return `<${tag}>${itemsHtml.join('\n')}</${tag}>`
  }

  function renderTable(tbl: any): string {
    const rows = odfTableRows(tbl)
    if (rows.length === 0) return ''
    const htmlRows = rows.map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`).join('\n')
    return `<div class="odf-table-wrap"><table class="odf-table"><tbody>${htmlRows}</tbody></table></div>`
  }

  function processBlocks(node: any): void {
    if (!node || typeof node !== 'object') return

    for (const [k, v] of Object.entries(node)) {
      if (k.startsWith('@_')) continue

      if (k === 'p') {
        const list = Array.isArray(v) ? v : [v]
        for (const p of list) htmlChunks.push(renderParagraph(p, 'p'))
      } else if (k === 'h') {
        const list = Array.isArray(v) ? v : [v]
        for (const h of list) {
          const lvl = Math.min(parseInt(String((h as any)?.['@_outline-level'] || '1'), 10), 6)
          htmlChunks.push(renderParagraph(h, `h${lvl}`))
        }
      } else if (k === 'list') {
        const list = Array.isArray(v) ? v : [v]
        for (const l of list) htmlChunks.push(renderList(l, false))
      } else if (k === 'table') {
        const list = Array.isArray(v) ? v : [v]
        for (const t of list) htmlChunks.push(renderTable(t))
      } else if (typeof v === 'object') {
        processBlocks(v)
      }
    }
  }

  processBlocks(body)

  const extraCss = `
.odf-p { margin: 0 0 4pt 0; }
table.odf-table { border-collapse: collapse; width: 100%; margin: 10pt 0; }
table.odf-table td, table.odf-table th { border: 1px solid ${theme.alt}; padding: 6px 10px; }
.odf-table-wrap { overflow-x: auto; margin: 8pt 0; }
`

  return renderOfficeHtmlShell({
    bodyHtml: htmlChunks.join('\n'),
    theme,
    containerClass: 'odf-container',
    extraCss,
  })
}

function odfInline(node: any): string {
  if (!node) return ''
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)

  const parts: string[] = []
  if (node['#text'] !== undefined) parts.push(String(node['#text']))

  for (const [k, v] of Object.entries(node)) {
    if (k.startsWith('@_')) continue
    if (k === 's') {
      const count = parseInt(String((v as any)?.['@_c'] || '1'), 10)
      parts.push(' '.repeat(Math.min(count, 50)))
    } else if (k === 'tab') {
      parts.push('\t')
    } else if (k === 'line-break') {
      parts.push('\n')
    } else if (k !== 'note') {
      if (Array.isArray(v)) {
        for (const item of v) parts.push(odfInline(item))
      } else if (typeof v === 'object') {
        parts.push(odfInline(v))
      }
    }
  }

  return parts.join('')
}

function odfList(listNode: any, out: Array<{ text: string; tight: boolean }>, depth: number): void {
  const items = Array.isArray(listNode?.['list-item'])
    ? listNode['list-item']
    : listNode?.['list-item']
      ? [listNode['list-item']]
      : []

  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    for (const [k, v] of Object.entries(item)) {
      if (k === 'p' || k === 'h') {
        const list = Array.isArray(v) ? v : [v]
        for (const el of list) {
          const s = odfInline(el).trim()
          if (s) out.push({ text: `${'  '.repeat(depth)}• ${s}`, tight: true })
        }
      } else if (k === 'list') {
        odfList(v, out, depth + 1)
      }
    }
  }
}

function odfTableRows(tblNode: any): string[][] {
  const rows: string[][] = []

  function collectRows(node: any): any[] {
    if (!node || typeof node !== 'object') return []
    const r: any[] = []
    const trList = node?.['table-row']
    if (trList) {
      if (Array.isArray(trList)) r.push(...trList)
      else r.push(trList)
    }
    if (node?.['table-header-rows']) r.push(...collectRows(node['table-header-rows']))
    if (node?.['table-row-group']) r.push(...collectRows(node['table-row-group']))
    return r
  }

  const allRows = collectRows(tblNode)

  for (const row of allRows) {
    const cells: string[] = []
    const cellList: any[] = []
    if (row?.['table-cell']) {
      if (Array.isArray(row['table-cell'])) cellList.push(...row['table-cell'])
      else cellList.push(row['table-cell'])
    }
    if (row?.['covered-table-cell']) {
      if (Array.isArray(row['covered-table-cell'])) cellList.push(...row['covered-table-cell'])
      else cellList.push(row['covered-table-cell'])
    }

    for (const cell of cellList) {
      const texts: string[] = []
      for (const [k, v] of Object.entries(cell)) {
        if (k === 'p' || k === 'h') {
          const pList = Array.isArray(v) ? v : [v]
          for (const p of pList) {
            const s = odfInline(p).trim()
            if (s) texts.push(s)
          }
        }
      }
      const cellText = texts.join(' ')
      const repeat = Math.min(parseInt(String((cell as any)?.['@_number-columns-repeated'] || '1'), 10), MAX_COLS)
      for (let i = 0; i < repeat; i++) {
        if (cells.length < MAX_COLS) cells.push(cellText)
      }
      if (cells.length >= MAX_COLS) break
    }

    const rowRepeat = Math.min(
      parseInt(String(row?.['@_number-rows-repeated'] || '1'), 10),
      cells.some(Boolean) ? 20 : 1
    )
    for (let i = 0; i < rowRepeat; i++) {
      rows.push([...cells])
      if (rows.length >= MAX_ROWS) break
    }
    if (rows.length >= MAX_ROWS) break
  }

  return trimRows(rows)
}

function odfBlocks(node: any, out: Array<{ text: string; tight: boolean }>): void {
  if (!node || typeof node !== 'object') return

  for (const [k, v] of Object.entries(node)) {
    if (k.startsWith('@_')) continue

    if (k === 'p') {
      const list = Array.isArray(v) ? v : [v]
      for (const p of list) {
        const s = odfInline(p).trim()
        if (s) out.push({ text: s, tight: false })
      }
    } else if (k === 'h') {
      const list = Array.isArray(v) ? v : [v]
      for (const h of list) {
        const s = odfInline(h).trim()
        if (s) {
          const lvl = Math.min(parseInt(String((h as any)?.['@_outline-level'] || '1'), 10), 4)
          out.push({ text: `${'#'.repeat(lvl)} ${s}`, tight: false })
        }
      }
    } else if (k === 'list') {
      const list = Array.isArray(v) ? v : [v]
      for (const l of list) odfList(l, out, 0)
    } else if (k === 'table') {
      const list = Array.isArray(v) ? v : [v]
      for (const t of list) {
        const rows = odfTableRows(t)
        if (rows.length > 0) out.push({ text: fmtRows(rows, false), tight: false })
      }
    } else if (typeof v === 'object') {
      odfBlocks(v, out)
    }
  }
}

export async function parseOdfDocument(filePath: string): Promise<PaginatedDoc> {
  const xml = readZipEntryText(filePath, 'content.xml')
  if (!xml) throw new Error(t('office.odfContentNotFound'))

  const body = xmlParser.parse(xml)?.['document-content']?.body || xmlParser.parse(xml)?.body
  if (!body) return { pages: [t('office.emptyDoc')], font: 0, wrap: true }

  if (body.spreadsheet) {
    const pages: string[] = []
    const tables = Array.isArray(body.spreadsheet.table)
      ? body.spreadsheet.table
      : body.spreadsheet.table
        ? [body.spreadsheet.table]
        : []

    for (const tbl of tables) {
      const rows = odfTableRows(tbl)
      const title = String((tbl as any)?.['@_name'] || t('spreadsheet.sheet'))
      pages.push(...paginate(`── ${title} ──\n\n${rows.length > 0 ? fmtRows(rows, true) : t('spreadsheet.emptySheet')}`))
    }

    return {
      pages: pages.length > 0 ? pages : [t('spreadsheet.emptySheet')],
      font: 2,
      wrap: false,
    }
  }

  if (body.presentation) {
    const pages: string[] = []
    const slides = Array.isArray(body.presentation.page)
      ? body.presentation.page
      : body.presentation.page
        ? [body.presentation.page]
        : []

    for (let i = 0; i < slides.length; i++) {
      const blocks: Array<{ text: string; tight: boolean }> = []
      odfBlocks(slides[i], blocks)
      pages.push(`${t('office.slideHeader', { index: i + 1 })}\n\n${joinBlocks(blocks) || t('office.noText')}`)
    }

    return {
      pages: pages.length > 0 ? pages : [t('office.emptyPresentation')],
      font: 0,
      wrap: true,
    }
  }

  const blocks: Array<{ text: string; tight: boolean }> = []
  odfBlocks(body, blocks)

  return {
    pages: paginate(joinBlocks(blocks) || t('office.emptyDoc')),
    font: 0,
    wrap: true,
  }
}