import { XMLParser } from 'fast-xml-parser'
import { readZipEntryText } from '../archive/zip/helper.js'
import { evaluateFormula, type FormulaCell } from './formula.js'
import { formatCellValue } from './numberFormat.js'
import {
  SPREADSHEET_LIMITS,
  type ThemeColors,
  colLetter,
  renderSpreadsheetAppHtml,
  type SpreadsheetSheetSpec,
} from './render.js'
import { escapeHtml } from '../utils/html.js'
import { t } from '../i18n/index.js'

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  trimValues: false,
})

interface OdsCellStyle {
  bold?: boolean
  italic?: boolean
  underline?: boolean
  fontSize?: string
  fontColor?: string
  bgColor?: string
  alignH?: string
  alignV?: string
  border?: boolean
}

function parseOdsStyles(xml: string): Record<string, OdsCellStyle> {
  const parsed = xmlParser.parse(xml)
  const stylesMap: Record<string, OdsCellStyle> = {}

  const collectStyles = (styleList: any[]) => {
    for (const s of styleList) {
      const name = String(s?.['@_name'] || '')
      if (!name) continue

      const cellProps = s['table-cell-properties']
      const textProps = s['text-properties']
      const pProps = s['paragraph-properties']

      stylesMap[name] = {
        bold: textProps?.['@_font-weight'] === 'bold' || textProps?.['@_font-weight-asian'] === 'bold',
        italic: textProps?.['@_font-style'] === 'italic' || textProps?.['@_font-style-asian'] === 'italic',
        underline: textProps?.['@_text-underline-style'] === 'solid',
        fontSize: textProps?.['@_font-size'],
        fontColor: textProps?.['@_color'],
        bgColor: cellProps?.['@_background-color'],
        alignH: pProps?.['@_text-align'] === 'end' ? 'right' : pProps?.['@_text-align'] === 'start' ? 'left' : pProps?.['@_text-align'],
        alignV: cellProps?.['@_vertical-align'],
        border: Boolean(cellProps?.['@_border'] || cellProps?.['@_border-top']),
      }
    }
  }

  const autoStyles = parsed?.['document-content']?.['automatic-styles']?.style || parsed?.document?.['automatic-styles']?.style
  if (autoStyles) {
    collectStyles(Array.isArray(autoStyles) ? autoStyles : [autoStyles])
  }

  return stylesMap
}

function cleanOdsFormula(formulaStr: string): string {
  let f = formulaStr.trim()
  if (f.startsWith('of:=')) f = f.slice(4)
  else if (f.startsWith('oooc:=')) f = f.slice(6)
  else if (f.startsWith('=')) f = f.slice(1)
  return f.replace(/\[\.\$?([A-Z0-9]+)\]/gi, '$1').replace(/\[\.([A-Z0-9]+:\.[A-Z0-9]+)\]/gi, (_, p) => p.replace(/\./g, ''))
}

export async function buildOdsSpreadsheetHtml(filePath: string, theme: ThemeColors): Promise<string> {
  const contentXml = readZipEntryText(filePath, 'content.xml')
  if (!contentXml) throw new Error('Malformed OpenDocument spreadsheet: missing content.xml')

  const stylesXml = readZipEntryText(filePath, 'styles.xml') || ''
  const stylesMap: Record<string, OdsCellStyle> = {
    ...parseOdsStyles(stylesXml),
    ...parseOdsStyles(contentXml),
  }

  const parsed = xmlParser.parse(contentXml)
  const spreadsheet = parsed?.['document-content']?.body?.spreadsheet || parsed?.document?.body?.spreadsheet
  if (!spreadsheet) throw new Error('No spreadsheet body found in OpenDocument file')

  const tableNodes = spreadsheet.table
  const tables = (Array.isArray(tableNodes) ? tableNodes : tableNodes ? [tableNodes] : []).slice(0, SPREADSHEET_LIMITS.MAX_SHEETS)

  if (tables.length === 0) {
    return `<div class="spreadsheet-empty" style="padding:24px;color:${escapeHtml(theme.fg)};">${escapeHtml(t('spreadsheet.empty'))}</div>`
  }

  const sheetsForApp: SpreadsheetSheetSpec[] = []

  for (let sIdx = 0; sIdx < tables.length; sIdx++) {
    const table = tables[sIdx]
    const sheetName = String(table['@_name'] || `Sheet ${sIdx + 1}`)
    const rawRows = table['table-row'] || table.row
    const rowList = Array.isArray(rawRows) ? rawRows : rawRows ? [rawRows] : []

    const cellMap: Record<string, FormulaCell> = {}
    const cellDataMap: Record<string, { val: any; styleName?: string; isString?: boolean }> = {}
    const merges: Array<{ startCol: number; startRow: number; endCol: number; endRow: number }> = []
    const skipMap = new Map<string, boolean>()

    let maxColIdx = 0
    let currRow = 0
    let isTruncated = false

    for (const r of rowList) {
      if (currRow >= SPREADSHEET_LIMITS.MAX_ROWS) {
        isTruncated = true
        break
      }

      const rowsRepeated = Math.min(
        parseInt(String(r['@_number-rows-repeated'] || 1), 10),
        SPREADSHEET_LIMITS.MAX_ROWS - currRow
      )

      const rawCells = r['table-cell'] || r.cell
      const cellList = Array.isArray(rawCells) ? rawCells : rawCells ? [rawCells] : []

      let currCol = 0
      for (const cell of cellList) {
        if (currCol >= SPREADSHEET_LIMITS.MAX_COLS) {
          isTruncated = true
          break
        }

        const colsRepeatedRaw = parseInt(String(cell['@_number-columns-repeated'] || 1), 10)
        const colsSpanned = parseInt(String(cell['@_number-columns-spanned'] || 1), 10)
        const rowsSpanned = parseInt(String(cell['@_number-rows-spanned'] || 1), 10)
        const formulaRaw = cell['@_formula'] ? cleanOdsFormula(String(cell['@_formula'])) : null
        const valType = cell['@_value-type']
        const officeVal = cell['@_value']
        const styleName = cell['@_style-name']

        let cellText = ''
        if (cell.p !== undefined) {
          if (typeof cell.p === 'string') cellText = cell.p
          else if (Array.isArray(cell.p)) cellText = cell.p.map((p: any) => (typeof p === 'string' ? p : p['#text'] ?? '')).join('\n')
          else cellText = cell.p['#text'] ?? ''
        } else if (officeVal !== undefined) {
          cellText = String(officeVal)
        }

        const isCellEmpty = !cellText && !formulaRaw && !cell['@_value']
        const colsRepeated = isCellEmpty ? Math.min(colsRepeatedRaw, 1) : Math.min(colsRepeatedRaw, SPREADSHEET_LIMITS.MAX_COLS - currCol)

        for (let rep = 0; rep < colsRepeated; rep++) {
          const c = currCol
          if (c >= SPREADSHEET_LIMITS.MAX_COLS) break
          if (c > maxColIdx && !isCellEmpty) maxColIdx = c

          for (let rRep = 0; rRep < rowsRepeated; rRep++) {
            const rowIdx = currRow + rRep
            const cellRef = `${colLetter(c)}${rowIdx + 1}`

            let rawVal: any = officeVal !== undefined ? officeVal : cellText
            if (valType === 'float' || valType === 'currency' || valType === 'percentage') {
              const parsedNum = parseFloat(String(rawVal))
              if (!isNaN(parsedNum)) rawVal = parsedNum
            } else if (valType === 'boolean') {
              rawVal = String(rawVal).toLowerCase() === 'true'
            }

            cellMap[cellRef] = { rawVal, formula: formulaRaw }
            cellDataMap[cellRef] = { val: rawVal, styleName, isString: valType === 'string' }

            if (colsSpanned > 1 || rowsSpanned > 1) {
              merges.push({
                startCol: c,
                startRow: rowIdx,
                endCol: c + colsSpanned - 1,
                endRow: rowIdx + rowsSpanned - 1,
              })
              for (let mr = rowIdx; mr < rowIdx + rowsSpanned; mr++) {
                for (let mc = c; mc < c + colsSpanned; mc++) {
                  if (mr !== rowIdx || mc !== c) skipMap.set(`${mc},${mr}`, true)
                }
              }
            }
          }
          currCol++
        }
      }

      currRow += rowsRepeated
    }

    const cellResolver = (ref: string): FormulaCell | undefined => cellMap[ref.toUpperCase()]
    const tableRowsHtml: string[] = []

    for (let r = 0; r < currRow; r++) {
      const rowCellsHtml: string[] = []
      rowCellsHtml.push(`<th class="row-header" scope="row">${r + 1}</th>`)

      for (let c = 0; c <= maxColIdx; c++) {
        if (skipMap.get(`${c},${r}`)) continue

        const ref = `${colLetter(c)}${r + 1}`
        const cellInfo = cellDataMap[ref]
        const cellEntry = cellMap[ref]

        let displayVal = ''
        if (cellEntry) {
          if (cellEntry.formula) {
            const evalRes = evaluateFormula(cellEntry.formula, cellResolver)
            if (evalRes.success) {
              displayVal = String(evalRes.value)
            } else if (cellEntry.rawVal !== undefined && cellEntry.rawVal !== null && cellEntry.rawVal !== '') {
              displayVal = String(cellEntry.rawVal)
            } else {
              displayVal = evalRes.error || '#VALUE!'
            }
          } else {
            displayVal = cellInfo?.val !== undefined && cellInfo?.val !== null ? String(cellInfo.val) : ''
          }
        }

        let formattedText = displayVal
        if (!cellInfo?.isString && displayVal !== '' && !displayVal.startsWith('#')) {
          const num = Number(displayVal)
          if (!isNaN(num)) formattedText = formatCellValue(num)
        }

        let spanAttr = ''
        const merge = merges.find((m) => m.startCol === c && m.startRow === r)
        if (merge) {
          const cSpan = merge.endCol - merge.startCol + 1
          const rSpan = merge.endRow - merge.startRow + 1
          if (cSpan > 1) spanAttr += ` colspan="${cSpan}"`
          if (rSpan > 1) spanAttr += ` rowspan="${rSpan}"`
        }

        const style = cellInfo?.styleName ? stylesMap[cellInfo.styleName] : undefined
        const cssParts: string[] = []
        if (style) {
          if (style.bold) cssParts.push('font-weight:bold;')
          if (style.italic) cssParts.push('font-style:italic;')
          if (style.underline) cssParts.push('text-decoration:underline;')
          if (style.fontSize) cssParts.push(`font-size:${style.fontSize};`)
          if (style.fontColor) cssParts.push(`color:${style.fontColor};`)
          if (style.bgColor) cssParts.push(`background-color:${style.bgColor};`)
          if (style.alignH) cssParts.push(`text-align:${style.alignH};`)
          if (style.alignV) cssParts.push(`vertical-align:${style.alignV};`)
          if (style.border) cssParts.push('border:1px solid var(--grid-border-dark);')
        }

        const styleAttr = cssParts.length > 0 ? ` style="${cssParts.join('')}"` : ''
        rowCellsHtml.push(`<td${spanAttr}${styleAttr}>${escapeHtml(formattedText)}</td>`)
      }

      tableRowsHtml.push(`<tr>${rowCellsHtml.join('')}</tr>`)
    }

    const colgroupHtml: string[] = ['<col style="width:44px;min-width:44px;">']
    const colHeadersHtml: string[] = ['<th class="corner-cell" scope="col"></th>']

    for (let c = 0; c <= maxColIdx; c++) {
      colgroupHtml.push('<col style="width:96px;min-width:96px;">')
      colHeadersHtml.push(`<th class="col-header" scope="col" style="width:96px;min-width:96px;">${colLetter(c)}</th>`)
    }

    sheetsForApp.push({
      title: sheetName,
      banner: isTruncated ? t('spreadsheet.truncated', { rows: currRow, cols: maxColIdx + 1 }) : undefined,
      colgroupHtml: colgroupHtml.join('\n'),
      colHeadersHtml: colHeadersHtml.join(''),
      tableRowsHtml: tableRowsHtml.join(''),
    })
  }

  return renderSpreadsheetAppHtml(sheetsForApp, theme)
}