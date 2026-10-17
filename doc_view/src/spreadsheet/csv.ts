import type { PaginatedDoc } from '../types.js'
import { paginate, readTextDocumentAsync } from '../viewer/text/textReader.js'
import { fmtRows, trimRows } from '../utils/tableFormatter.js'
import {
  SPREADSHEET_LIMITS,
  type ThemeColors,
  colLetter,
  renderSpreadsheetAppHtml,
  type SpreadsheetSheetSpec,
} from './render.js'
import { escapeHtml } from '../utils/html.js'
import { t } from '../i18n/index.js'

export function parseCsvRows(text: string, delimiter?: string): string[][] {
  return parseDelimitedText(text, delimiter).rows
}

export function parseDelimitedText(
  text: string,
  forcedDelimiter?: string
): { rows: string[][]; delimiter: string } {
  const cleanText = text.startsWith('\uFEFF') ? text.slice(1) : text

  let delimiter = forcedDelimiter
  if (!delimiter) {
    const firstLine = cleanText.split('\n')[0] || ''
    const tabs = (firstLine.match(/\t/g) || []).length
    const semicolons = (firstLine.match(/;/g) || []).length
    const commas = (firstLine.match(/,/g) || []).length

    if (tabs > semicolons && tabs > commas) delimiter = '\t'
    else if (semicolons > commas) delimiter = ';'
    else delimiter = ','
  }

  const rows: string[][] = []
  let currentRow: string[] = []
  let currentField = ''
  let insideQuotes = false
  let i = 0
  const len = cleanText.length

  while (i < len) {
    const ch = cleanText[i]

    if (insideQuotes) {
      if (ch === '"') {
        if (i + 1 < len && cleanText[i + 1] === '"') {
          currentField += '"'
          i += 2
          continue
        }
        insideQuotes = false
        i++
        continue
      }
      currentField += ch
      i++
      continue
    }

    if (ch === '"') {
      insideQuotes = true
      i++
      continue
    }

    if (ch === delimiter) {
      currentRow.push(currentField)
      currentField = ''
      i++
      continue
    }

    if (ch === '\r') {
      if (i + 1 < len && cleanText[i + 1] === '\n') i++
      currentRow.push(currentField)
      currentField = ''
      rows.push(currentRow)
      currentRow = []
      i++
      continue
    }

    if (ch === '\n') {
      currentRow.push(currentField)
      currentField = ''
      rows.push(currentRow)
      currentRow = []
      i++
      continue
    }

    currentField += ch
    i++
  }

  if (currentField !== '' || currentRow.length > 0) {
    currentRow.push(currentField)
    rows.push(currentRow)
  }

  return { rows, delimiter }
}

export function formatCsvDocument(text: string, ext = 'csv'): PaginatedDoc {
  const delim = ext === 'tsv' || ext === 'tab' ? '\t' : undefined
  const { rows } = parseDelimitedText(text, delim)
  const trimmed = trimRows(rows)
  if (trimmed.length === 0) return { pages: [t('spreadsheet.empty')], font: 2, wrap: false }

  const MAX_TEXT_ROWS = 500
  const displayedRows = trimmed.slice(0, MAX_TEXT_ROWS)
  const body = fmtRows(displayedRows, true)
  const note = trimmed.length > MAX_TEXT_ROWS ? `\n\n… ${t('spreadsheet.truncatedRows', { rows: MAX_TEXT_ROWS })}` : ''

  return {
    pages: paginate(body + note),
    font: 2,
    wrap: false,
  }
}

export async function buildCsvSpreadsheetHtml(
  filePath: string,
  extension: string,
  theme: ThemeColors
): Promise<string> {
  const textDoc = await readTextDocumentAsync(filePath)
  const delim = extension === 'tsv' || extension === 'tab' ? '\t' : undefined
  const { rows } = parseDelimitedText(textDoc.pages.join(''), delim)

  if (rows.length === 0) {
    return `<div class="spreadsheet-empty" style="padding:24px;color:${escapeHtml(theme.fg)};">${escapeHtml(t('spreadsheet.empty'))}</div>`
  }

  let maxColIdx = 0
  for (const r of rows) {
    if (r.length - 1 > maxColIdx) {
      maxColIdx = Math.min(r.length - 1, SPREADSHEET_LIMITS.MAX_COLS - 1)
    }
  }

  const isTruncatedRows = rows.length > SPREADSHEET_LIMITS.MAX_ROWS
  const displayedRows = rows.slice(0, SPREADSHEET_LIMITS.MAX_ROWS)
  const tableRowsHtml: string[] = []

  for (let r = 0; r < displayedRows.length; r++) {
    const row = displayedRows[r]
    const rowCellsHtml: string[] = []
    rowCellsHtml.push(`<th class="row-header" scope="row">${r + 1}</th>`)

    for (let c = 0; c <= maxColIdx; c++) {
      rowCellsHtml.push(`<td>${escapeHtml(c < row.length ? row[c] : '')}</td>`)
    }
    tableRowsHtml.push(`<tr>${rowCellsHtml.join('')}</tr>`)
  }

  const colgroupHtml: string[] = ['<col style="width:44px;min-width:44px;">']
  const colHeadersHtml: string[] = ['<th class="corner-cell" scope="col"></th>']

  for (let c = 0; c <= maxColIdx; c++) {
    colgroupHtml.push('<col style="width:110px;min-width:110px;">')
    colHeadersHtml.push(`<th class="col-header" scope="col">${colLetter(c)}</th>`)
  }

  const sheets: SpreadsheetSheetSpec[] = [
    {
      title: 'Sheet1',
      banner: isTruncatedRows ? t('spreadsheet.truncatedRows', { rows: SPREADSHEET_LIMITS.MAX_ROWS }) : undefined,
      colgroupHtml: colgroupHtml.join('\n'),
      colHeadersHtml: colHeadersHtml.join(''),
      tableRowsHtml: tableRowsHtml.join(''),
    },
  ]

  return renderSpreadsheetAppHtml(sheets, theme)
}