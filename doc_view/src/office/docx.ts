import { XMLParser } from 'fast-xml-parser'
import type { PaginatedDoc } from '../types.js'
import { readZipEntryText, readZipEntryBase64 } from '../archive/zip/helper.js'
import { escapeHtml, sanitizeSafeUrl } from '../utils/html.js'
import { renderOfficeHtmlShell } from './render.js'
import { t } from '../i18n/index.js'

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  trimValues: false,
})

interface RunStyle {
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
  subscript?: boolean
  superscript?: boolean
  fontSizePt?: number
  fontFamily?: string
  color?: string
  highlight?: string
}

interface ParaStyle {
  align?: 'left' | 'center' | 'right' | 'justify'
  firstLineIndentPt?: number
  leftIndentPt?: number
  rightIndentPt?: number
  spaceBeforePt?: number
  spaceAfterPt?: number
  lineHeightRatio?: number
  tag?: string
  runStyle?: RunStyle
}

interface DocxStyles {
  defaults: {
    run: RunStyle
    para: ParaStyle
  }
  stylesById: Map<string, { para: ParaStyle; run: RunStyle; basedOn?: string }>
}

interface NumberingDef {
  format: string
  bullet?: string
}

function parseTwipsToPt(twips: any): number | undefined {
  if (twips === undefined || twips === null) return undefined
  const val = parseFloat(String(twips))
  return isNaN(val) ? undefined : Math.round((val / 20.0) * 10) / 10
}

function parseHalfPtToPt(halfPt: any): number | undefined {
  if (halfPt === undefined || halfPt === null) return undefined
  const val = parseFloat(String(halfPt))
  return isNaN(val) ? undefined : Math.round((val / 2.0) * 10) / 10
}

function parseEmuToPt(emus: any): number | undefined {
  if (emus === undefined || emus === null) return undefined
  const val = parseFloat(String(emus))
  return isNaN(val) ? undefined : Math.round(val / 12700.0)
}

function normalizeColor(color: any): string | undefined {
  if (!color || typeof color !== 'string') return undefined
  const clean = color.trim()
  if (clean === 'auto') return undefined
  return /^[0-9a-fA-F]{6}$/.test(clean) ? `#${clean}` : undefined
}

function parseRunProperties(rPr: any): RunStyle {
  if (!rPr || typeof rPr !== 'object') return {}
  const style: RunStyle = {}

  if (rPr.b !== undefined && rPr.b?.['@_val'] !== '0' && rPr.b?.['@_val'] !== 'false') style.bold = true
  if (rPr.i !== undefined && rPr.i?.['@_val'] !== '0' && rPr.i?.['@_val'] !== 'false') style.italic = true
  if (rPr.u !== undefined && rPr.u?.['@_val'] !== 'none') style.underline = true
  if (rPr.strike !== undefined && rPr.strike?.['@_val'] !== '0' && rPr.strike?.['@_val'] !== 'false') style.strike = true

  const vertAlign = rPr.vertAlign?.['@_val']
  if (vertAlign === 'superscript') style.superscript = true
  if (vertAlign === 'subscript') style.subscript = true

  if (rPr.sz?.['@_val'] !== undefined) style.fontSizePt = parseHalfPtToPt(rPr.sz['@_val'])

  const rFonts = rPr.rFonts
  if (rFonts) {
    const font = rFonts['@_ascii'] || rFonts['@_hAnsi'] || rFonts['@_cs']
    if (font) style.fontFamily = String(font)
  }

  if (rPr.color?.['@_val']) style.color = normalizeColor(rPr.color['@_val'])
  if (rPr.highlight?.['@_val'] && rPr.highlight['@_val'] !== 'none') style.highlight = rPr.highlight['@_val']

  return style
}

function parseParaProperties(pPr: any): ParaStyle {
  if (!pPr || typeof pPr !== 'object') return {}
  const style: ParaStyle = {}

  const jc = pPr.jc?.['@_val']
  if (jc === 'center') style.align = 'center'
  else if (jc === 'both' || jc === 'distribute') style.align = 'justify'
  else if (jc === 'right') style.align = 'right'
  else if (jc === 'left') style.align = 'left'

  if (pPr.ind) {
    if (pPr.ind['@_firstLine'] !== undefined) style.firstLineIndentPt = parseTwipsToPt(pPr.ind['@_firstLine'])
    if (pPr.ind['@_left'] !== undefined) style.leftIndentPt = parseTwipsToPt(pPr.ind['@_left'])
    if (pPr.ind['@_right'] !== undefined) style.rightIndentPt = parseTwipsToPt(pPr.ind['@_right'])
  }

  if (pPr.spacing) {
    if (pPr.spacing['@_before'] !== undefined) style.spaceBeforePt = parseTwipsToPt(pPr.spacing['@_before'])
    if (pPr.spacing['@_after'] !== undefined) style.spaceAfterPt = parseTwipsToPt(pPr.spacing['@_after'])
    if (pPr.spacing['@_line'] !== undefined && (pPr.spacing['@_lineRule'] === 'auto' || !pPr.spacing['@_lineRule'])) {
      const ratio = parseFloat(String(pPr.spacing['@_line'])) / 240.0
      if (!isNaN(ratio) && ratio > 0) style.lineHeightRatio = Math.round(ratio * 100) / 100
    }
  }

  if (pPr.rPr) style.runStyle = parseRunProperties(pPr.rPr)

  return style
}

function parseStylesXml(stylesXml: string | null): DocxStyles {
  const result: DocxStyles = {
    defaults: { run: {}, para: {} },
    stylesById: new Map(),
  }
  if (!stylesXml) return result

  try {
    const stylesNode = xmlParser.parse(stylesXml)?.styles
    if (!stylesNode) return result

    const docDefaults = stylesNode.docDefaults
    if (docDefaults) {
      if (docDefaults.rPrDefault?.rPr) result.defaults.run = parseRunProperties(docDefaults.rPrDefault.rPr)
      if (docDefaults.pPrDefault?.pPr) result.defaults.para = parseParaProperties(docDefaults.pPrDefault.pPr)
    }

    const rawStyles = Array.isArray(stylesNode.style)
      ? stylesNode.style
      : stylesNode.style
        ? [stylesNode.style]
        : []

    for (const s of rawStyles) {
      const id = s['@_styleId']
      if (!id) continue
      const para = parseParaProperties(s.pPr)
      const run = parseRunProperties(s.rPr)
      const name = String(s.name?.['@_val'] || id).toLowerCase()
      const m = name.match(/heading\s*(\d)/i) || id.match(/heading\s*(\d)/i)

      if (m) para.tag = `h${Math.min(parseInt(m[1], 10), 6)}`
      else if (name === 'title') para.tag = 'h1'
      else if (name === 'subtitle') para.tag = 'h2'

      result.stylesById.set(id, { para, run, basedOn: s.basedOn?.['@_val'] })
    }
  } catch { }

  return result
}

function resolveParaStyle(styleId: string | undefined, styles: DocxStyles): { para: ParaStyle; run: RunStyle } {
  let currId = styleId
  const paraMerged: ParaStyle = { ...styles.defaults.para }
  const runMerged: RunStyle = { ...styles.defaults.run }

  const chain: string[] = []
  while (currId && styles.stylesById.has(currId) && !chain.includes(currId)) {
    chain.unshift(currId)
    currId = styles.stylesById.get(currId)?.basedOn
  }

  for (const id of chain) {
    const s = styles.stylesById.get(id)
    if (s) {
      Object.assign(paraMerged, s.para)
      Object.assign(runMerged, s.run)
    }
  }

  return { para: paraMerged, run: runMerged }
}

function parseRelationships(relsXml: string | null): Map<string, { target: string; type: string }> {
  const rels = new Map<string, { target: string; type: string }>()
  if (!relsXml) return rels

  try {
    const rawRels = Array.isArray(xmlParser.parse(relsXml)?.Relationships?.Relationship)
      ? xmlParser.parse(relsXml).Relationships.Relationship
      : xmlParser.parse(relsXml)?.Relationships?.Relationship
        ? [xmlParser.parse(relsXml).Relationships.Relationship]
        : []

    for (const r of rawRels) {
      const id = r['@_Id']
      const target = r['@_Target']
      if (id && target) rels.set(id, { target, type: r['@_Type'] || '' })
    }
  } catch { }

  return rels
}

function parseNumberingXml(numberingXml: string | null): Map<string, NumberingDef> {
  const result = new Map<string, NumberingDef>()
  if (!numberingXml) return result

  try {
    const parsed = xmlParser.parse(numberingXml)
    const abstractNums = Array.isArray(parsed?.numbering?.abstractNum)
      ? parsed.numbering.abstractNum
      : parsed?.numbering?.abstractNum
        ? [parsed.numbering.abstractNum]
        : []

    const abstractMap = new Map<string, NumberingDef>()
    for (const an of abstractNums) {
      const anId = an['@_abstractNumId']
      const lvl = Array.isArray(an.lvl) ? an.lvl[0] : an.lvl
      abstractMap.set(anId, { format: lvl?.numFmt?.['@_val'] || 'bullet' })
    }

    const nums = Array.isArray(parsed?.numbering?.num)
      ? parsed.numbering.num
      : parsed?.numbering?.num
        ? [parsed.numbering.num]
        : []

    for (const num of nums) {
      const numId = num['@_numId']
      const anId = num.abstractNumId?.['@_val']
      if (numId && anId && abstractMap.has(anId)) {
        result.set(numId, abstractMap.get(anId)!)
      }
    }
  } catch { }

  return result
}

export class DocxHtmlConverter {
  private filePath: string
  private styles: DocxStyles
  private rels: Map<string, { target: string; type: string }>
  private numbering: Map<string, NumberingDef>
  private listCounters = new Map<string, number>()

  constructor(filePath: string) {
    this.filePath = filePath
    this.styles = parseStylesXml(readZipEntryText(filePath, 'word/styles.xml'))
    this.rels = parseRelationships(readZipEntryText(filePath, 'word/_rels/document.xml.rels'))
    this.numbering = parseNumberingXml(readZipEntryText(filePath, 'word/numbering.xml'))
  }

  public convert(): string {
    const documentXml = readZipEntryText(this.filePath, 'word/document.xml')
    if (!documentXml) throw new Error(t('office.docxNotFound'))

    const body = xmlParser.parse(documentXml)?.document?.body
    if (!body) return `<div class="docx-empty">${t('office.emptyDoc')}</div>`

    return this.parseBodyNodes(body)
  }

  private parseBodyNodes(node: any): string {
    const htmlChunks: string[] = []
    if (!node || typeof node !== 'object') return ''

    for (const [key, val] of Object.entries(node)) {
      if (key.startsWith('@_')) continue

      if (key === 'p') {
        const list = Array.isArray(val) ? val : [val]
        for (const p of list) htmlChunks.push(this.renderParagraph(p))
      } else if (key === 'tbl') {
        const list = Array.isArray(val) ? val : [val]
        for (const tbl of list) htmlChunks.push(this.renderTable(tbl))
      } else if (key === 'sdt') {
        const list = Array.isArray(val) ? val : [val]
        for (const sdt of list) {
          const content = (sdt as any)?.sdtContent
          if (content) htmlChunks.push(this.parseBodyNodes(content))
        }
      }
    }

    return htmlChunks.join('\n')
  }

  private renderParagraph(p: any): string {
    const pPr = p?.pPr || {}
    const resolved = resolveParaStyle(pPr.pStyle?.['@_val'], this.styles)
    const effectivePara: ParaStyle = { ...resolved.para, ...parseParaProperties(pPr) }

    const numPr = pPr.numPr
    let listPrefix = ''
    if (numPr) {
      const numId = String(numPr.numId?.['@_val'] || '')
      const numDef = this.numbering.get(numId)
      if (numDef && numDef.format === 'decimal') {
        const count = (this.listCounters.get(numId) || 0) + 1
        this.listCounters.set(numId, count)
        listPrefix = `<span class="docx-num">${count}. </span>`
      } else {
        listPrefix = `<span class="docx-bullet">• </span>`
      }
    }

    const runsHtml = this.renderRuns(p, resolved.run)
    if (!runsHtml.trim() && !listPrefix) {
      return '<p class="docx-p docx-empty-p"></p>'
    }

    const cssStyles: string[] = []
    if (effectivePara.align) cssStyles.push(`text-align: ${effectivePara.align}`)
    if (effectivePara.firstLineIndentPt !== undefined && effectivePara.firstLineIndentPt > 0) {
      cssStyles.push(`text-indent: ${effectivePara.firstLineIndentPt}pt`)
    }
    if (effectivePara.leftIndentPt !== undefined && effectivePara.leftIndentPt > 0) {
      cssStyles.push(`margin-left: ${effectivePara.leftIndentPt}pt`)
    }
    if (effectivePara.rightIndentPt !== undefined && effectivePara.rightIndentPt > 0) {
      cssStyles.push(`margin-right: ${effectivePara.rightIndentPt}pt`)
    }
    if (effectivePara.spaceBeforePt !== undefined && effectivePara.spaceBeforePt > 0) {
      cssStyles.push(`margin-top: ${effectivePara.spaceBeforePt}pt`)
    }
    if (effectivePara.spaceAfterPt !== undefined && effectivePara.spaceAfterPt > 0) {
      cssStyles.push(`margin-bottom: ${effectivePara.spaceAfterPt}pt`)
    }
    if (effectivePara.lineHeightRatio !== undefined) {
      cssStyles.push(`line-height: ${effectivePara.lineHeightRatio}`)
    }

    const styleAttr = cssStyles.length > 0 ? ` style="${cssStyles.join('; ')}"` : ''
    const tag = effectivePara.tag || 'p'
    return `<${tag} class="docx-p"${styleAttr}>${listPrefix}${runsHtml}</${tag}>`
  }

  private renderRuns(p: any, baseRunStyle: RunStyle): string {
    const parts: string[] = []
    const walk = (n: any) => {
      if (!n || typeof n !== 'object') return

      for (const [k, v] of Object.entries(n)) {
        if (k.startsWith('@_')) continue

        if (k === 'r') {
          const rList = Array.isArray(v) ? v : [v]
          for (const r of rList) parts.push(this.renderSingleRun(r, baseRunStyle))
        } else if (k === 'hyperlink') {
          const hList = Array.isArray(v) ? v : [v]
          for (const h of hList) {
            const rId = h['@_id']
            const rel = rId ? this.rels.get(rId) : null
            const url = rel ? sanitizeSafeUrl(rel.target) : '#'
            parts.push(`<a href="${url}" class="docx-link" target="_blank">${this.renderRuns(h, baseRunStyle)}</a>`)
          }
        } else if (k === 'drawing' || k === 'pict') {
          parts.push(this.renderDrawing(v))
        } else if (Array.isArray(v)) {
          for (const item of v) walk(item)
        } else if (typeof v === 'object' && k !== 'pPr') {
          walk(v)
        }
      }
    }

    walk(p)
    return parts.join('')
  }

  private renderSingleRun(r: any, baseRunStyle: RunStyle): string {
    const effective: RunStyle = { ...baseRunStyle, ...parseRunProperties(r.rPr) }
    const textPieces: string[] = []

    for (const [k, v] of Object.entries(r)) {
      if (k.startsWith('@_') || k === 'rPr') continue
      if (k === 't') {
        if (Array.isArray(v)) {
          for (const item of v) textPieces.push(escapeHtml(this.extractRawText(item)))
        } else {
          textPieces.push(escapeHtml(this.extractRawText(v)))
        }
      } else if (k === 'tab') {
        textPieces.push('<span class="docx-tab">&emsp;</span>')
      } else if (k === 'br' || k === 'cr') {
        textPieces.push('<br>')
      } else if (k === 'drawing' || k === 'pict') {
        textPieces.push(this.renderDrawing(v))
      }
    }

    let text = textPieces.join('')
    if (!text) return ''

    if (effective.bold) text = `<strong>${text}</strong>`
    if (effective.italic) text = `<em>${text}</em>`
    if (effective.underline) text = `<u>${text}</u>`
    if (effective.strike) text = `<s>${text}</s>`
    if (effective.subscript) text = `<sub>${text}</sub>`
    if (effective.superscript) text = `<sup>${text}</sup>`

    const cssStyles: string[] = []
    if (effective.fontSizePt !== undefined) cssStyles.push(`font-size: ${effective.fontSizePt}pt`)
    if (effective.fontFamily) cssStyles.push(`font-family: '${effective.fontFamily}', serif`)
    if (effective.color) cssStyles.push(`color: ${effective.color}`)
    if (effective.highlight) cssStyles.push(`background-color: ${effective.highlight}`)

    return cssStyles.length > 0 ? `<span style="${cssStyles.join('; ')}">${text}</span>` : text
  }

  private renderDrawing(drawing: any): string {
    try {
      const blip = this.findFirstByTag(drawing, 'blip')
      const embedId = blip?.['@_embed'] || blip?.['@_link']
      if (!embedId) return ''

      const rel = this.rels.get(embedId)
      if (!rel?.target) return ''

      let targetPath = rel.target.replace(/^\//, '')
      if (!targetPath.startsWith('word/')) targetPath = `word/${targetPath}`

      const base64Data = readZipEntryBase64(this.filePath, targetPath)
      if (!base64Data) return ''

      const lower = targetPath.toLowerCase()
      let mime = 'image/png'
      if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) mime = 'image/jpeg'
      else if (lower.endsWith('.gif')) mime = 'image/gif'
      else if (lower.endsWith('.webp')) mime = 'image/webp'
      else if (lower.endsWith('.svg')) mime = 'image/svg+xml'

      const extent = this.findFirstByTag(drawing, 'extent')
      let sizeStyles = 'max-width: 100%; height: auto;'
      if (extent) {
        const widthPt = parseEmuToPt(extent['@_cx'])
        if (widthPt && widthPt > 10) {
          sizeStyles = `max-width: 100%; width: ${Math.min(widthPt, 600)}pt; height: auto;`
        }
      }

      return `<img src="data:${mime};base64,${base64Data}" style="${sizeStyles} display: inline-block; vertical-align: middle; margin: 4px 0;" alt="" />`
    } catch {
      return ''
    }
  }

  private renderTable(tbl: any): string {
    const rowsHtml: string[] = []
    const trList = Array.isArray(tbl.tr) ? tbl.tr : tbl.tr ? [tbl.tr] : []

    for (const tr of trList) {
      const cellsHtml: string[] = []
      const tcList = Array.isArray(tr.tc) ? tr.tc : tr.tc ? [tr.tc] : []

      for (const tc of tcList) {
        const tcPr = tc.tcPr || {}
        const cellAttrs: string[] = []
        const cellStyles: string[] = ['padding: 6px 10px', 'border: 1px solid currentColor']

        if (tcPr.gridSpan?.['@_val']) cellAttrs.push(`colspan="${tcPr.gridSpan['@_val']}"`)

        const vMerge = tcPr.vMerge
        if (vMerge && (!vMerge['@_val'] || vMerge['@_val'] === 'continue')) continue

        const color = normalizeColor(tcPr.shd?.['@_fill'])
        if (color) cellStyles.push(`background-color: ${color}`)
        if (tcPr.vAlign?.['@_val']) cellStyles.push(`vertical-align: ${tcPr.vAlign['@_val']}`)

        const styleStr = cellStyles.length > 0 ? ` style="${cellStyles.join('; ')}"` : ''
        const attrStr = cellAttrs.length > 0 ? ' ' + cellAttrs.join(' ') : ''
        cellsHtml.push(`<td${attrStr}${styleStr}>${this.parseBodyNodes(tc)}</td>`)
      }

      if (cellsHtml.length > 0) rowsHtml.push(`<tr>\n${cellsHtml.join('\n')}\n</tr>`)
    }

    return `<div class="docx-table-wrap"><table class="docx-table" style="border-collapse: collapse; width: 100%; margin: 12px 0;">\n<tbody>\n${rowsHtml.join('\n')}\n</tbody>\n</table></div>`
  }

  private extractRawText(node: any): string {
    if (!node) return ''
    if (typeof node === 'string') return node
    if (typeof node === 'number') return String(node)
    return node['#text'] !== undefined ? String(node['#text']) : ''
  }

  private findFirstByTag(obj: any, tag: string): any {
    if (!obj || typeof obj !== 'object') return null
    if (obj[tag]) return obj[tag]
    for (const v of Object.values(obj)) {
      if (Array.isArray(v)) {
        for (const item of v) {
          const res = this.findFirstByTag(item, tag)
          if (res) return res
        }
      } else if (typeof v === 'object') {
        const res = this.findFirstByTag(v, tag)
        if (res) return res
      }
    }
    return null
  }
}

export function buildDocxHtml(filePath: string, theme: { bg: string; fg: string; alt: string }): string {
  const bodyContent = new DocxHtmlConverter(filePath).convert()
  const extraCss = `
.docx-p { margin: 0 0 4pt 0; }
.docx-empty-p { min-height: 14pt; }
h1 { font-size: 18pt; }
h2 { font-size: 16pt; }
h3 { font-size: 15pt; }
a.docx-link { color: #4da3ff; text-decoration: underline; }
.docx-tab { display: inline-block; min-width: 2em; }
.docx-num, .docx-bullet { font-weight: bold; display: inline-block; min-width: 1.5em; }
.docx-table-wrap { overflow-x: auto; margin: 8pt 0; }
table.docx-table { border-collapse: collapse; width: 100%; }
table.docx-table td, table.docx-table th { border: 1px solid ${theme.alt}; padding: 6px 10px; }
`

  return renderOfficeHtmlShell({
    bodyHtml: bodyContent,
    theme,
    containerClass: 'docx-container',
    extraCss,
  })
}

export async function parseDocxDocument(filePath: string): Promise<PaginatedDoc> {
  const html = new DocxHtmlConverter(filePath).convert()
  const plainText = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || t('office.emptyDoc')
  return {
    pages: [plainText],
    font: 0,
    wrap: true,
  }
}