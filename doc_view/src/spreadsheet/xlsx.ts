import { XMLParser } from 'fast-xml-parser'
import type { PaginatedDoc } from '../types.js'
import { paginate } from '../viewer/text/textReader.js'
import { fmtRows, naturalSort, trimRows } from '../utils/tableFormatter.js'
import { listZipEntries, readZipEntryText, openZipFile, closeZipFile } from '../archive/zip/helper.js'
import { evaluateFormula, type FormulaCell } from './formula.js'
import { formatCellValue } from './numberFormat.js'
import {
  SPREADSHEET_LIMITS,
  type ThemeColors,
  colIndex,
  colLetter,
  parseCellColRow,
  shiftFormula,
  renderSpreadsheetAppHtml,
  type SpreadsheetSheetSpec,
} from './render.js'
import { escapeHtml } from '../utils/html.js'
import { t } from '../i18n/index.js'

export { SPREADSHEET_LIMITS, type ThemeColors, shiftFormula }

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  processEntities: false,
  removeNSPrefix: true,
  trimValues: false,
})

interface ParsedStyle {
  numFmtId: number
  formatCode?: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
  fontSize?: number
  fontColor?: string
  fillColor?: string
  alignH?: string
  alignV?: string
  wrapText?: boolean
  borderTop?: boolean
  borderBottom?: boolean
  borderLeft?: boolean
  borderRight?: boolean
}

function isDarkColor(hex?: string): boolean {
  if (!hex || typeof hex !== 'string' || !hex.startsWith('#') || hex.length !== 7) return false
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return 0.299 * r + 0.587 * g + 0.114 * b < 128
}

function unescapeXml(text: string): string {
  if (!text || !text.includes('&')) return text || ''
  return text
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(Number(dec)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
}

function truncateSheetXml(xml: string, maxRows: number): string {
  let rowCount = 0
  let pos = 0
  let lastRowEnd = -1
  const sheetDataStart = xml.indexOf('<sheetData')
  if (sheetDataStart === -1) return xml

  pos = sheetDataStart
  while (rowCount < maxRows) {
    const rowStart = xml.indexOf('<row', pos)
    if (rowStart === -1) break
    const rowEnd = xml.indexOf('</row>', rowStart)
    if (rowEnd === -1) {
      const selfClose = xml.indexOf('/>', rowStart)
      if (selfClose !== -1) {
        rowCount++
        lastRowEnd = selfClose + 2
        pos = lastRowEnd
        continue
      }
      break
    }
    rowCount++
    lastRowEnd = rowEnd + 6
    pos = lastRowEnd
  }

  return lastRowEnd !== -1 && rowCount >= maxRows
    ? xml.slice(0, lastRowEnd) + '</sheetData></worksheet>'
    : xml
}

function parseSharedStrings(xml: string): string[] {
  const out: string[] = []
  let pos = 0
  const maxStrings = SPREADSHEET_LIMITS.MAX_SHARED_STRINGS

  while (out.length < maxStrings) {
    const siStart = xml.indexOf('<si', pos)
    if (siStart === -1) break
    const siEnd = xml.indexOf('</si>', siStart)
    if (siEnd === -1) break

    let tPos = siStart
    let text = ''
    while (tPos < siEnd) {
      const tStart = xml.indexOf('<t', tPos)
      if (tStart === -1 || tStart >= siEnd) break
      const tagClose = xml.indexOf('>', tStart)
      if (tagClose === -1 || tagClose >= siEnd) break
      const tEnd = xml.indexOf('</t>', tagClose)
      if (tEnd === -1 || tEnd > siEnd) break

      text += xml.slice(tagClose + 1, tEnd)
      tPos = tEnd + 4
    }

    out.push(unescapeXml(text))
    pos = siEnd + 5
  }

  return out
}

function normalizeZipPath(target: string): string {
  let clean = target.replace(/\\/g, '/')
  if (clean.startsWith('/')) clean = clean.slice(1)
  return clean.startsWith('xl/') ? clean : `xl/${clean}`
}

function parseWorkbookRels(relsXml: string): Record<string, string> {
  const parsed = xmlParser.parse(relsXml)
  const rels = parsed?.Relationships?.Relationship
  const relList = Array.isArray(rels) ? rels : rels ? [rels] : []
  const relMap: Record<string, string> = {}

  for (const r of relList) {
    const id = String(r?.['@_Id'] || '')
    const target = String(r?.['@_Target'] || '')
    if (id && target) relMap[id] = normalizeZipPath(target)
  }

  return relMap
}

function parseStyles(stylesXml: string): { styles: ParsedStyle[]; customFormats: Record<string, string> } {
  const parsed = xmlParser.parse(stylesXml)
  const root = parsed?.styleSheet
  if (!root) return { styles: [], customFormats: {} }

  const customFormats: Record<string, string> = {}
  if (root.numFmts?.numFmt) {
    const list = Array.isArray(root.numFmts.numFmt) ? root.numFmts.numFmt : [root.numFmts.numFmt]
    for (const nf of list) {
      const id = String(nf?.['@_numFmtId'] ?? '')
      const code = String(nf?.['@_formatCode'] ?? '')
      if (id) customFormats[id] = code
    }
  }

  const fonts: any[] = []
  if (root.fonts?.font) {
    const list = Array.isArray(root.fonts.font) ? root.fonts.font : [root.fonts.font]
    for (const f of list) {
      fonts.push({
        bold: f.b !== undefined,
        italic: f.i !== undefined,
        underline: f.u !== undefined,
        strike: f.strike !== undefined,
        size: f.sz ? parseFloat(String(f.sz?.['@_val'] ?? 11)) : undefined,
        color: f.color?.['@_rgb'] ? `#${String(f.color['@_rgb']).slice(-6)}` : undefined,
      })
    }
  }

  const fills: any[] = []
  if (root.fills?.fill) {
    const list = Array.isArray(root.fills.fill) ? root.fills.fill : [root.fills.fill]
    for (const f of list) {
      let color: string | undefined
      const pf = f.patternFill
      if (pf) {
        const fg = pf.fgColor?.['@_rgb']
        if (fg) color = `#${String(fg).slice(-6)}`
        else if (pf['@_patternType'] === 'lightGray') color = '#e0e0e0'
      }
      fills.push({ color })
    }
  }

  const borders: any[] = []
  if (root.borders?.border) {
    const list = Array.isArray(root.borders.border) ? root.borders.border : [root.borders.border]
    for (const b of list) {
      borders.push({
        left: b.left && Object.keys(b.left).length > 0,
        right: b.right && Object.keys(b.right).length > 0,
        top: b.top && Object.keys(b.top).length > 0,
        bottom: b.bottom && Object.keys(b.bottom).length > 0,
      })
    }
  }

  const styles: ParsedStyle[] = []
  if (root.cellXfs?.xf) {
    const list = Array.isArray(root.cellXfs.xf) ? root.cellXfs.xf : [root.cellXfs.xf]
    for (const xf of list) {
      const numFmtId = parseInt(String(xf?.['@_numFmtId'] ?? 0), 10)
      const fontId = parseInt(String(xf?.['@_fontId'] ?? -1), 10)
      const fillId = parseInt(String(xf?.['@_fillId'] ?? -1), 10)
      const borderId = parseInt(String(xf?.['@_borderId'] ?? -1), 10)
      const align = xf.alignment

      const font = fontId >= 0 && fontId < fonts.length ? fonts[fontId] : null
      const fill = fillId >= 0 && fillId < fills.length ? fills[fillId] : null
      const border = borderId >= 0 && borderId < borders.length ? borders[borderId] : null

      styles.push({
        numFmtId,
        formatCode: customFormats[String(numFmtId)],
        bold: font?.bold,
        italic: font?.italic,
        underline: font?.underline,
        strike: font?.strike,
        fontSize: font?.size,
        fontColor: font?.color,
        fillColor: fill?.color,
        alignH: align?.['@_horizontal'],
        alignV: align?.['@_vertical'],
        wrapText: String(align?.['@_wrapText']) === '1',
        borderTop: border?.top,
        borderBottom: border?.bottom,
        borderLeft: border?.left,
        borderRight: border?.right,
      })
    }
  }

  return { styles, customFormats }
}

interface MergeInfo {
  startCol: number
  startRow: number
  endCol: number
  endRow: number
}

function parseMerges(worksheet: any): { merges: MergeInfo[]; skipMap: Map<string, boolean> } {
  const merges: MergeInfo[] = []
  const skipMap = new Map<string, boolean>()
  const mergeCells = worksheet?.mergeCells?.mergeCell
  const list = Array.isArray(mergeCells) ? mergeCells : mergeCells ? [mergeCells] : []

  for (const m of list) {
    const ref = String(m?.['@_ref'] || '')
    const parts = ref.split(':')
    if (parts.length === 2) {
      const start = parseCellColRow(parts[0])
      const end = parseCellColRow(parts[1])
      if (start && end) {
        merges.push({
          startCol: Math.min(start.col, end.col),
          startRow: Math.min(start.row, end.row),
          endCol: Math.max(start.col, end.col),
          endRow: Math.max(start.row, end.row),
        })
        for (let r = start.row; r <= end.row; r++) {
          for (let c = start.col; c <= end.col; c++) {
            if (r !== start.row || c !== start.col) {
              skipMap.set(`${c},${r}`, true)
            }
          }
        }
      }
    }
  }

  return { merges, skipMap }
}

export async function buildXlsxHtml(filePath: string, theme: ThemeColors): Promise<string> {
  const zip = openZipFile(filePath)
  try {
    const sharedXml = readZipEntryText(zip || filePath, 'xl/sharedStrings.xml')
    const shared = sharedXml ? parseSharedStrings(sharedXml) : []

    const stylesXml = readZipEntryText(zip || filePath, 'xl/styles.xml')
    const { styles } = stylesXml ? parseStyles(stylesXml) : { styles: [] }

    const workbookXml = readZipEntryText(zip || filePath, 'xl/workbook.xml')
    const workbookRelsXml = readZipEntryText(zip || filePath, 'xl/_rels/workbook.xml.rels')

    if (!workbookXml) throw new Error('Malformed Excel workbook: missing xl/workbook.xml')

    const relMap = workbookRelsXml ? parseWorkbookRels(workbookRelsXml) : {}
    let entryNames: Set<string> | null = null

    const wb = xmlParser.parse(workbookXml)
    const sheetNodes = wb?.workbook?.sheets?.sheet
    const sheetList = Array.isArray(sheetNodes) ? sheetNodes : sheetNodes ? [sheetNodes] : []

    interface SheetSpec {
      name: string
      part: string
    }
    const sheetSpecs: SheetSpec[] = []

    for (const s of sheetList) {
      if (sheetSpecs.length >= SPREADSHEET_LIMITS.MAX_SHEETS) break
      const name = String(s?.['@_name'] || `Sheet ${sheetSpecs.length + 1}`)
      const rId = String(s?.['@_id'] || s?.['@_r:id'] || '')
      const target = relMap[rId]
      if (target) {
        if (!entryNames) {
          const { entries } = listZipEntries(filePath, 200)
          entryNames = new Set(entries.map((e) => e.name))
        }
        if (entryNames.has(target)) {
          sheetSpecs.push({ name, part: target })
        }
      }
    }

    if (sheetSpecs.length === 0) {
      if (!entryNames) {
        const { entries } = listZipEntries(filePath, 200)
        entryNames = new Set(entries.map((e) => e.name))
      }
      const wsFiles = Array.from(entryNames)
        .filter((n) => /^xl\/worksheets\/[^/]+\.xml$/i.test(n))
        .sort(naturalSort)
      for (const f of wsFiles) {
        if (sheetSpecs.length >= SPREADSHEET_LIMITS.MAX_SHEETS) break
        sheetSpecs.push({ name: f.replace(/^xl\/worksheets\//i, '').replace(/\.xml$/i, ''), part: f })
      }
    }

    if (sheetSpecs.length === 0) {
      return `<div class="spreadsheet-empty" style="padding:24px;color:${escapeHtml(theme.fg)};">${escapeHtml(t('spreadsheet.empty'))}</div>`
    }

    const maxRowsForDoc = sheetSpecs.length <= 1
      ? SPREADSHEET_LIMITS.MAX_ROWS
      : sheetSpecs.length <= 3
        ? Math.min(SPREADSHEET_LIMITS.MAX_ROWS, 250)
        : Math.min(SPREADSHEET_LIMITS.MAX_ROWS, 150)

    const sheetsForApp: SpreadsheetSheetSpec[] = []

    for (let sIdx = 0; sIdx < sheetSpecs.length; sIdx++) {
      if (sIdx > 0) await new Promise((resolve) => setTimeout(resolve, 0))
      const { name, part } = sheetSpecs[sIdx]
      const rawSheetXml = readZipEntryText(zip || filePath, part)
      if (!rawSheetXml) continue

      const sheetXml = truncateSheetXml(rawSheetXml, maxRowsForDoc)
      const ws = xmlParser.parse(sheetXml)?.worksheet
      const sheetData = ws?.sheetData
      const { merges, skipMap } = parseMerges(ws)
      const mergeStartMap = new Map<string, MergeInfo>()
      for (const m of merges) {
        mergeStartMap.set(`${m.startCol},${m.startRow}`, m)
      }

      const defaultColWidth = ws?.sheetFormatPr?.['@_defaultColWidth']
        ? parseFloat(String(ws.sheetFormatPr['@_defaultColWidth']))
        : 11
      const defaultPx = Math.max(50, Math.round(defaultColWidth * 8.5))

      const colWidths: Record<number, number> = {}
      if (ws?.cols?.col) {
        const colNodes = Array.isArray(ws.cols.col) ? ws.cols.col : [ws.cols.col]
        for (const c of colNodes) {
          const min = parseInt(String(c?.['@_min'] || 1), 10) - 1
          const max = parseInt(String(c?.['@_max'] || 1), 10) - 1
          const w = parseFloat(String(c?.['@_width'] || defaultColWidth))
          for (let col = min; col <= max && col < SPREADSHEET_LIMITS.MAX_COLS; col++) {
            colWidths[col] = Math.max(36, Math.round(w * 8.5))
          }
        }
      }

      const sharedFormulas = new Map<string, { baseCol: number; baseRow: number; formula: string }>()

      interface SheetCell extends FormulaCell {
        val: any
        styleIdx?: number
        isString?: boolean
        sharedSi?: string | null
        col: number
        row: number
      }

      const cellMap: Record<string, SheetCell> = {}
      const rowLastOccupiedCol: Record<number, number> = {}

      let maxColIdx = 0
      let maxRowIdx = 0
      let rowCount = 0
      let isTruncated = false

      const rawRows = sheetData?.row
      const rowList = Array.isArray(rawRows) ? rawRows : rawRows ? [rawRows] : []

      for (const r of rowList) {
        if (rowCount >= maxRowsForDoc) {
          isTruncated = true
          break
        }
        rowCount++
        const rNum = parseInt(String(r?.['@_r'] || rowCount), 10) - 1
        if (rNum > maxRowIdx && rNum < maxRowsForDoc) maxRowIdx = rNum

        const rawC = r?.c
        const cList = Array.isArray(rawC) ? rawC : rawC ? [rawC] : []

        for (const c of cList) {
          const rAttr = String(c?.['@_r'] || '')
          const pos = parseCellColRow(rAttr)
          const col = pos ? pos.col : 0
          const row = pos ? pos.row : rNum

          if (col >= SPREADSHEET_LIMITS.MAX_COLS) {
            isTruncated = true
            continue
          }
          if (col > maxColIdx) maxColIdx = col

          const tType = String(c?.['@_t'] || 'n')
          const rawV = c?.v !== undefined ? (typeof c.v === 'object' ? c.v?.['#text'] : c.v) : null
          const v = rawV !== null && rawV !== undefined ? String(rawV) : ''
          const styleIdx = c?.['@_s'] !== undefined ? parseInt(String(c['@_s']), 10) : undefined

          let formulaText: string | null = null
          let sharedSi: string | null = null

          if (c?.f !== undefined) {
            if (typeof c.f === 'object') {
              const tAttr = c.f['@_t']
              const siAttr = c.f['@_si']
              const textVal = c.f['#text'] !== undefined ? String(c.f['#text']) : ''
              if (tAttr === 'shared' && siAttr !== undefined) {
                sharedSi = String(siAttr)
                if (textVal) {
                  formulaText = textVal
                  sharedFormulas.set(sharedSi, { baseCol: col, baseRow: row, formula: textVal })
                }
              } else {
                formulaText = textVal || null
              }
            } else {
              formulaText = String(c.f)
            }
          }

          let cellVal: any = v
          let isString = false

          if (tType === 'inlineStr' || c?.is) {
            const isNode = c.is
            cellVal = typeof isNode === 'string' ? isNode : isNode?.t?.['#text'] ?? isNode?.t ?? ''
            isString = true
          } else if (tType === 's') {
            const sIdx = parseInt(v, 10)
            cellVal = !isNaN(sIdx) && sIdx >= 0 && sIdx < shared.length ? shared[sIdx] : ''
            isString = true
          } else if (tType === 'b') {
            cellVal = v.trim() === '1'
          }

          const cellRef = rAttr.toUpperCase() || `${colLetter(col)}${row + 1}`
          cellMap[cellRef] = {
            rawVal: cellVal,
            val: cellVal,
            formula: formulaText,
            sharedSi,
            col,
            row,
            styleIdx,
            isString,
          }
          if (cellVal !== '' && cellVal !== null && cellVal !== undefined) {
            if (rowLastOccupiedCol[row] === undefined || col > rowLastOccupiedCol[row]) {
              rowLastOccupiedCol[row] = col
            }
          }
        }
      }

      for (const ref of Object.keys(cellMap)) {
        const entry = cellMap[ref]
        if (!entry.formula && entry.sharedSi !== null && entry.sharedSi !== undefined) {
          const master = sharedFormulas.get(entry.sharedSi)
          if (master) {
            entry.formula = shiftFormula(master.formula, entry.col - master.baseCol, entry.row - master.baseRow)
          }
        }
      }

      const cellResolver = (ref: string): FormulaCell | undefined => cellMap[ref.toUpperCase()]
      const tableRowsHtml: string[] = []

      for (let r = 0; r <= maxRowIdx; r++) {
        if (r > 0 && r % 80 === 0) await new Promise((resolve) => setTimeout(resolve, 0))
        const rowCellsHtml: string[] = []
        rowCellsHtml.push(`<th class="row-header" scope="row">${r + 1}</th>`)

        for (let c = 0; c <= maxColIdx; c++) {
          if (skipMap.get(`${c},${r}`)) continue

          const ref = `${colLetter(c)}${r + 1}`
          const cell = cellMap[ref]

          let displayVal = ''
          if (cell) {
            if (cell.formula) {
              const evalRes = evaluateFormula(cell.formula, cellResolver)
              if (evalRes.success) {
                displayVal = String(evalRes.value)
                cell.rawVal = evalRes.value as any
              } else {
                if (evalRes.error === '#NAME?' && cell.rawVal !== undefined && cell.rawVal !== null && cell.rawVal !== '') {
                  displayVal = String(cell.rawVal)
                } else {
                  displayVal = evalRes.error || '#VALUE!'
                }
              }
            } else {
              displayVal = cell.val !== undefined && cell.val !== null ? String(cell.val) : ''
            }
          }

          const style = cell?.styleIdx !== undefined && cell.styleIdx < styles.length ? styles[cell.styleIdx] : undefined
          let formattedText = displayVal

          if (!cell?.isString && displayVal !== '' && !displayVal.startsWith('#')) {
            const num = Number(displayVal)
            if (!isNaN(num)) {
              formattedText = formatCellValue(num, {
                numFmtId: style?.numFmtId,
                formatCode: style?.formatCode,
              })
            }
          }

          let spanAttr = ''
          let isSpannedToEnd = false
          const merge = mergeStartMap.get(`${c},${r}`)

          if (merge) {
            const cSpan = merge.endCol - merge.startCol + 1
            const rSpan = merge.endRow - merge.startRow + 1
            if (cSpan > 1) spanAttr += ` colspan="${cSpan}"`
            if (rSpan > 1) spanAttr += ` rowspan="${rSpan}"`
          } else if (formattedText.trim() !== '' && cell?.isString && c < maxColIdx) {
            const lastOccupied = rowLastOccupiedCol[r] ?? -1
            if (c >= lastOccupied) {
              spanAttr += ` colspan="${maxColIdx - c + 1}"`
              isSpannedToEnd = true
            }
          }

          const cssParts: string[] = []
          if (style) {
            if (style.bold) cssParts.push('font-weight:bold;')
            if (style.italic) cssParts.push('font-style:italic;')
            if (style.underline) cssParts.push('text-decoration:underline;')
            if (style.fontSize) cssParts.push(`font-size:${style.fontSize}pt;`)

            const themeBgIsDark = isDarkColor(theme.bg)
            if (style.fontColor) {
              const fontIsDark = isDarkColor(style.fontColor)
              if (fontIsDark && themeBgIsDark) {
                if (style.fillColor && !isDarkColor(style.fillColor)) cssParts.push(`color:${style.fontColor};`)
              } else if (!fontIsDark && !themeBgIsDark) {
                if (style.fillColor && isDarkColor(style.fillColor)) cssParts.push(`color:${style.fontColor};`)
              } else {
                cssParts.push(`color:${style.fontColor};`)
              }
            }

            if (style.fillColor) cssParts.push(`background-color:${style.fillColor};`)
            if (style.alignH) cssParts.push(`text-align:${style.alignH};`)
            if (style.alignV) cssParts.push(`vertical-align:${style.alignV};`)
            if (style.wrapText || isSpannedToEnd) {
              cssParts.push('white-space:pre-wrap;word-break:break-word;overflow:visible;text-overflow:clip;')
            }
            if (style.borderTop) cssParts.push('border-top:1px solid var(--grid-border-dark);')
            if (style.borderBottom) cssParts.push('border-bottom:1px solid var(--grid-border-dark);')
            if (style.borderLeft) cssParts.push('border-left:1px solid var(--grid-border-dark);')
            if (style.borderRight) cssParts.push('border-right:1px solid var(--grid-border-dark);')
          } else if (isSpannedToEnd) {
            cssParts.push('white-space:pre-wrap;word-break:break-word;overflow:visible;text-overflow:clip;')
          }

          const styleAttr = cssParts.length > 0 ? ` style="${cssParts.join('')}"` : ''
          rowCellsHtml.push(`<td${spanAttr}${styleAttr}>${escapeHtml(formattedText)}</td>`)

          if (isSpannedToEnd) break
        }

        tableRowsHtml.push(`<tr>${rowCellsHtml.join('')}</tr>`)
      }

      const colgroupHtml: string[] = ['<col style="width:44px;min-width:44px;">']
      const colHeadersHtml: string[] = ['<th class="corner-cell" scope="col"></th>']

      for (let c = 0; c <= maxColIdx; c++) {
        const w = colWidths[c] || defaultPx
        colgroupHtml.push(`<col style="width:${w}px;min-width:${w}px;">`)
        colHeadersHtml.push(`<th class="col-header" scope="col" style="width:${w}px;min-width:${w}px;">${colLetter(c)}</th>`)
      }

      sheetsForApp.push({
        title: name,
        banner: isTruncated ? t('spreadsheet.truncated', { rows: maxRowIdx + 1, cols: maxColIdx + 1 }) : undefined,
        colgroupHtml: colgroupHtml.join('\n'),
        colHeadersHtml: colHeadersHtml.join(''),
        tableRowsHtml: tableRowsHtml.join(''),
      })
    }

    return renderSpreadsheetAppHtml(sheetsForApp, theme)
  } finally {
    closeZipFile(zip)
  }
}

export async function parseXlsxDocument(filePath: string): Promise<PaginatedDoc> {
  const sharedXml = readZipEntryText(filePath, 'xl/sharedStrings.xml')
  const shared = sharedXml ? parseSharedStrings(sharedXml) : []

  const stylesXml = readZipEntryText(filePath, 'xl/styles.xml')
  const { styles } = stylesXml ? parseStyles(stylesXml) : { styles: [] }

  const { entries } = listZipEntries(filePath, 200)
  const entryNames = entries.map((e) => e.name)

  const sheetEntries: Array<{ title: string; part: string }> = []
  const workbookXml = readZipEntryText(filePath, 'xl/workbook.xml')
  const workbookRelsXml = readZipEntryText(filePath, 'xl/_rels/workbook.xml.rels')

  if (workbookXml && workbookRelsXml) {
    try {
      const relMap = parseWorkbookRels(workbookRelsXml)
      const wb = xmlParser.parse(workbookXml)
      const sheets = wb?.workbook?.sheets?.sheet
      const sheetList = Array.isArray(sheets) ? sheets : sheets ? [sheets] : []
      for (const s of sheetList) {
        const name = String(s?.['@_name'] || '')
        const rId = String(s?.['@_id'] || s?.['@_r:id'] || '')
        const target = relMap[rId]
        if (target && entryNames.includes(target)) {
          sheetEntries.push({ title: name || target, part: target })
        }
      }
    } catch { }
  }

  if (sheetEntries.length === 0) {
    const wsFiles = entryNames
      .filter((n) => /^xl\/worksheets\/[^/]+\.xml$/i.test(n))
      .sort(naturalSort)
    for (const f of wsFiles) {
      sheetEntries.push({ title: f.replace(/^xl\/worksheets\//i, '').replace(/\.xml$/i, ''), part: f })
    }
  }

  if (sheetEntries.length === 0) {
    return { pages: [t('spreadsheet.empty')], font: 2, wrap: false }
  }

  const pages: string[] = []

  for (const { title, part } of sheetEntries) {
    await new Promise((resolve) => setTimeout(resolve, 0))
    const sheetXml = readZipEntryText(filePath, part)
    if (!sheetXml) continue

    const sheetData = xmlParser.parse(sheetXml)?.worksheet?.sheetData
    if (!sheetData) continue

    const rows: string[][] = []
    let isCut = false
    const rowList = Array.isArray(sheetData.row) ? sheetData.row : sheetData.row ? [sheetData.row] : []

    for (let rIdx = 0; rIdx < rowList.length; rIdx++) {
      if (rIdx > 0 && rIdx % 80 === 0) await new Promise((resolve) => setTimeout(resolve, 0))
      const r = rowList[rIdx]
      const rNum = parseInt(String(r?.['@_r'] || ''), 10)
      if (!isNaN(rNum)) {
        const gap = rNum - 1 - rows.length
        if (gap > 0 && gap <= 30) {
          for (let g = 0; g < gap; g++) rows.push([])
        }
      }

      const cells: string[] = []
      const cList = Array.isArray(r.c) ? r.c : r.c ? [r.c] : []

      for (const c of cList) {
        const rAttr = String(c?.['@_r'] || '')
        const idx = rAttr ? colIndex(rAttr) : cells.length
        if (idx < 0 || idx >= SPREADSHEET_LIMITS.MAX_COLS) continue

        while (cells.length <= idx) cells.push('')

        const tType = String(c?.['@_t'] || 'n')
        const rawV = c?.v !== undefined ? (typeof c.v === 'object' ? c.v?.['#text'] : c.v) : null
        let v = rawV !== null && rawV !== undefined ? String(rawV) : ''
        if (tType === 's') {
          const sIdx = parseInt(v, 10)
          v = !isNaN(sIdx) && sIdx >= 0 && sIdx < shared.length ? shared[sIdx] : ''
        } else if (tType === 'b') {
          v = v.trim() === '1' ? 'TRUE' : 'FALSE'
        }

        const sAttr = c?.['@_s']
        if (sAttr !== undefined && v !== '') {
          const styleIdx = parseInt(String(sAttr), 10)
          if (!isNaN(styleIdx) && styleIdx < styles.length) {
            v = formatCellValue(v, {
              numFmtId: styles[styleIdx].numFmtId,
              formatCode: styles[styleIdx].formatCode,
            })
          }
        }
        cells[idx] = v
      }

      rows.push(cells)
      if (rows.length >= SPREADSHEET_LIMITS.MAX_ROWS) {
        isCut = true
        break
      }
    }

    const trimmed = trimRows(rows)
    const body = trimmed.length > 0 ? fmtRows(trimmed, true) : t('spreadsheet.sheetEmpty')
    let text = `── ${title} ──\n\n${body}`
    if (isCut) text += `\n\n… ${t('spreadsheet.truncatedRows', { rows: SPREADSHEET_LIMITS.MAX_ROWS })}`

    pages.push(...paginate(text))
  }

  return {
    pages: pages.length > 0 ? pages : [t('spreadsheet.sheetEmpty')],
    font: 2,
    wrap: false,
  }
}