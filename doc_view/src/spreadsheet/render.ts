import { escapeHtml } from '../utils/html.js'
import { t, getLanguage } from '../i18n/index.js'
import type {
  ThemeColors,
  SpreadsheetCellModel,
  SpreadsheetRowModel,
  SpreadsheetColModel,
  SpreadsheetSheetSpec,
  SpreadsheetLimits,
} from './types.js'

export type {
  ThemeColors,
  SpreadsheetCellModel,
  SpreadsheetRowModel,
  SpreadsheetColModel,
  SpreadsheetSheetSpec,
  SpreadsheetLimits,
}

export const SPREADSHEET_LIMITS = {
  MAX_SHEETS: 30,
  MAX_ROWS: 300,
  MAX_COLS: 40,
  MAX_SHARED_STRINGS: 50000,
  MAX_XML_SIZE_BYTES: 25 * 1024 * 1024,
  MAX_TOTAL_HTML_BYTES: 8 * 1024 * 1024,
}

/**
 * Converts a 0-based column index to an Excel column letter (0 -> 'A', 25 -> 'Z', 26 -> 'AA').
 */
export function colLetter(colIdx: number): string {
  let s = ''
  let c = colIdx + 1
  while (c > 0) {
    const rem = (c - 1) % 26
    s = String.fromCharCode(65 + rem) + s
    c = Math.floor((c - 1) / 26)
  }
  return s
}

/**
 * Extracts 0-based column index from a cell reference or column letter string (e.g. 'A' -> 0, 'Z' -> 25, 'AA' -> 26).
 */
export function colIndex(ref: string): number {
  let n = 0
  for (let i = 0; i < ref.length; i++) {
    const code = ref.charCodeAt(i)
    if (code >= 65 && code <= 90) { // 'A'..'Z'
      n = n * 26 + (code - 64)
    } else if (code >= 97 && code <= 122) { // 'a'..'z'
      n = n * 26 + (code - 96)
    } else {
      break
    }
  }
  return n - 1
}

/**
 * Parses a cell reference like 'B5' or 'AA10' into 0-based { col, row }.
 */
export function parseCellColRow(ref: string): { col: number; row: number } | null {
  const match = ref.match(/^([A-Za-z]+)([0-9]+)$/)
  if (!match) return null
  const col = colIndex(match[1])
  const row = parseInt(match[2], 10) - 1
  return { col, row }
}

/**
 * Converts 0-based col and row indices into a standard cell reference string (0, 0 -> 'A1').
 */
export function colRowToCellRef(col: number, row: number): string {
  return `${colLetter(col)}${row + 1}`
}

/**
 * Adjusts relative formula cell coordinates when a shared formula is copied to slave cells.
 */
export function shiftFormula(formula: string, deltaCol: number, deltaRow: number): string {
  if (deltaCol === 0 && deltaRow === 0) return formula
  return formula.replace(/(^|[^A-Za-z0-9_.])(\$?)([A-Za-z]{1,3})(\$?)([1-9]\d*)(?!\s*\()/g, (m, prefix, absCol, colStr, absRow, rowStr) => {
    let newCol = colStr
    let newRow = rowStr
    if (!absCol && deltaCol !== 0) {
      const origCol = colIndex(colStr)
      if (origCol >= 0) {
        newCol = colLetter(origCol + deltaCol)
      }
    }
    if (!absRow && deltaRow !== 0) {
      const origRow = parseInt(rowStr, 10)
      if (!isNaN(origRow)) {
        newRow = String(origRow + deltaRow)
      }
    }
    return `${prefix}${absCol}${newCol}${absRow}${newRow}`
  })
}


/**
 * Renders HTML for a single spreadsheet sheet table (colgroup, headers, rows).
 */
export function renderSheetTableHtml(spec: SpreadsheetSheetSpec): {
  colgroupHtml: string
  colHeadersHtml: string
  tableRowsHtml: string
} {
  if (spec.colgroupHtml && spec.colHeadersHtml && spec.tableRowsHtml) {
    return {
      colgroupHtml: spec.colgroupHtml,
      colHeadersHtml: spec.colHeadersHtml,
      tableRowsHtml: spec.tableRowsHtml,
    }
  }

  let maxCol = spec.maxColIdx ?? (spec.cols ? spec.cols.length - 1 : 0)
  if (spec.maxColIdx === undefined && (!spec.cols || spec.cols.length === 0) && spec.rows) {
    for (const r of spec.rows) {
      if (r.cells.length - 1 > maxCol) {
        maxCol = r.cells.length - 1
      }
    }
  }

  // Colgroup
  const colgroupHtml: string[] = []
  colgroupHtml.push('<col style="width:44px;min-width:44px;">')
  for (let c = 0; c <= maxCol; c++) {
    const w = spec.cols && spec.cols[c]?.widthPx ? spec.cols[c].widthPx : 110
    colgroupHtml.push(`<col style="width:${w}px;min-width:${w}px;">`)
  }

  // Column Headers
  const colHeadersHtml: string[] = []
  colHeadersHtml.push('<th class="corner-cell" scope="col"></th>')
  for (let c = 0; c <= maxCol; c++) {
    colHeadersHtml.push(`<th class="col-header" scope="col">${colLetter(c)}</th>`)
  }

  // Table Rows
  const tableRowsHtml: string[] = []
  if (spec.rows) {
    for (let r = 0; r < spec.rows.length; r++) {
      const row = spec.rows[r]
      const rowCellsHtml: string[] = []
      const rowHeader = row.header ?? String(r + 1)
      rowCellsHtml.push(`<th class="row-header" scope="row">${rowHeader}</th>`)

      for (let c = 0; c <= maxCol; c++) {
        const item = c < row.cells.length ? row.cells[c] : ''
        if (item === null || item === undefined) {
          rowCellsHtml.push('<td></td>')
        } else if (typeof item === 'object') {
          const spanAttrs = `${item.colSpan && item.colSpan > 1 ? ` colspan="${item.colSpan}"` : ''}${item.rowSpan && item.rowSpan > 1 ? ` rowspan="${item.rowSpan}"` : ''}`
          const styleAttr = item.style ? ` style="${item.style}"` : ''
          rowCellsHtml.push(`<td${spanAttrs}${styleAttr}>${escapeHtml(item.value)}</td>`)
        } else {
          rowCellsHtml.push(`<td>${escapeHtml(String(item))}</td>`)
        }
      }
      tableRowsHtml.push(`<tr>${rowCellsHtml.join('')}</tr>`)
    }
  }

  return {
    colgroupHtml: colgroupHtml.join('\n'),
    colHeadersHtml: colHeadersHtml.join(''),
    tableRowsHtml: tableRowsHtml.join(''),
  }
}

/**
 * Builds the complete unified mobile spreadsheet HTML/CSS application shell.
 */
export function renderSpreadsheetAppHtml(
  sheets: SpreadsheetSheetSpec[],
  theme: ThemeColors
): string {
  if (sheets.length === 0) {
    return `<div class="spreadsheet-empty" style="padding:24px;color:${escapeHtml(theme.fg)};">${escapeHtml(t('spreadsheet.empty'))}</div>`
  }

  const renderedPanes: string[] = []
  const tabButtons: string[] = []

  for (let i = 0; i < sheets.length; i++) {
    const s = sheets[i]
    const tableParts = renderSheetTableHtml(s)
    const bannerHtml = s.banner ? `<div class="sheet-banner">${s.banner}</div>` : ''
    const defaultSheetTitle = `${t('spreadsheet.sheet')} ${i + 1}`

    tabButtons.push(
      `<label for="tab-${i}" class="tab-label" id="tab-lbl-${i}">${escapeHtml(s.title || defaultSheetTitle)}</label>`
    )

    renderedPanes.push(`
      <div class="sheet-pane" id="sheet-pane-${i}">
        ${bannerHtml}
        <div class="sheet-scroll-container">
          <table class="sheet-table">
            <colgroup>
              ${tableParts.colgroupHtml}
            </colgroup>
            <thead><tr>${tableParts.colHeadersHtml}</tr></thead>
            <tbody>${tableParts.tableRowsHtml}</tbody>
          </table>
        </div>
      </div>
    `)
  }

  const radioInputs = sheets.map((_, i) =>
    `<input type="radio" name="sheet-tabs" id="tab-${i}" class="sheet-radio" ${i === 0 ? 'checked' : ''}>`
  ).join('\n')

  const tabCssRules = sheets.map((_, i) => `
    #tab-${i}:checked ~ .sheet-panes #sheet-pane-${i} { display: flex; }
    #tab-${i}:checked ~ .tab-bar label[for="tab-${i}"] {
      color: var(--accent-green);
      border-bottom: 3px solid var(--accent-green);
      font-weight: 600;
      background: var(--tab-active-bg);
    }
  `).join('\n')

  const bottomTabBar = sheets.length > 1
    ? `<nav class="tab-bar">${tabButtons.join('\n')}</nav>`
    : ''

  const isDark = !theme.bg || theme.bg.toLowerCase().startsWith('#0') || theme.bg.toLowerCase().startsWith('#1') || theme.bg.toLowerCase().startsWith('#2')
  const accentGreen = isDark ? '#2ecc71' : '#107c41'
  const tabActiveBg = isDark ? 'rgba(46, 204, 113, 0.22)' : 'rgba(16, 124, 65, 0.14)'
  const tabBarBg = isDark ? '#14141c' : '#f0f0f4'

  return `<!DOCTYPE html>
<html lang="${getLanguage()}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=5.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; frame-src 'none';">
  <style>
    :root {
      --bg: ${theme.bg};
      --fg: ${theme.fg};
      --alt: ${theme.alt};
      --grid-border: rgba(128, 128, 128, 0.25);
      --grid-border-dark: rgba(128, 128, 128, 0.6);
      --header-bg: ${theme.alt};
      --header-fg: ${theme.fg};
      --header-border: rgba(128, 128, 128, 0.35);
      --tab-bar-bg: ${tabBarBg};
      --tab-fg: ${theme.fg};
      --tab-active-bg: ${tabActiveBg};
      --accent-green: ${accentGreen};
      --font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    }

    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      width: 100%;
      height: 100%;
      background-color: var(--bg);
      color: var(--fg);
      font-family: var(--font-family);
      overflow: hidden;
    }

    .spreadsheet-app {
      display: flex;
      flex-direction: column;
      width: 100%;
      height: 100%;
      position: absolute;
      top: 0;
      left: 0;
    }

    .sheet-radio {
      display: none;
    }

    .sheet-panes {
      flex: 1;
      position: relative;
      overflow: hidden;
      display: flex;
    }

    .sheet-pane {
      display: none;
      flex-direction: column;
      width: 100%;
      height: 100%;
      position: absolute;
      top: 0;
      left: 0;
    }

    .sheet-banner {
      background: var(--header-bg);
      color: var(--header-fg);
      font-size: 11px;
      padding: 4px 12px;
      border-bottom: 1px solid var(--grid-border);
      text-align: center;
      opacity: 0.85;
    }

    .sheet-scroll-container {
      flex: 1;
      overflow: auto;
      -webkit-overflow-scrolling: touch;
      position: relative;
    }

    .sheet-table {
      border-collapse: separate;
      border-spacing: 0;
      table-layout: fixed;
      width: max-content;
      font-size: 13px;
      line-height: 1.4;
      background: var(--bg);
    }

    .sheet-table th,
    .sheet-table td {
      border-right: 1px solid var(--grid-border);
      border-bottom: 1px solid var(--grid-border);
      padding: 4px 8px;
      height: 24px;
      box-sizing: border-box;
    }

    .sheet-table td {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      vertical-align: middle;
    }

    .col-header {
      position: sticky;
      top: 0;
      z-index: 10;
      background: var(--header-bg);
      color: var(--header-fg);
      font-weight: 500;
      text-align: center;
      border-bottom: 1px solid var(--header-border) !important;
      user-select: none;
    }

    .row-header {
      position: sticky;
      left: 0;
      z-index: 10;
      background: var(--header-bg);
      color: var(--header-fg);
      font-weight: 500;
      text-align: center;
      width: 44px;
      min-width: 44px;
      border-right: 1px solid var(--header-border) !important;
      user-select: none;
    }

    .corner-cell {
      position: sticky;
      top: 0;
      left: 0;
      z-index: 20;
      background: var(--header-bg);
      border-right: 1px solid var(--header-border) !important;
      border-bottom: 1px solid var(--header-border) !important;
      width: 44px;
      min-width: 44px;
    }

    .tab-bar {
      display: flex;
      flex-direction: row;
      overflow-x: auto;
      overflow-y: hidden;
      background: var(--tab-bar-bg);
      border-top: 1px solid var(--header-border);
      height: 46px;
      min-height: 46px;
      box-sizing: border-box;
      -webkit-overflow-scrolling: touch;
      user-select: none;
      scrollbar-width: none;
      z-index: 50;
    }
    .tab-bar::-webkit-scrollbar {
      display: none;
    }

    .tab-label {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0 20px;
      font-size: 14px;
      font-weight: 500;
      color: var(--tab-fg);
      cursor: pointer;
      white-space: nowrap;
      border-right: 1px solid var(--grid-border);
      border-bottom: 3px solid transparent;
      transition: all 0.15s ease;
      height: 100%;
      box-sizing: border-box;
    }

    ${tabCssRules}
  </style>
</head>
<body>
  <div class="spreadsheet-app">
    ${radioInputs}
    <div class="sheet-panes">
      ${renderedPanes.join('\n')}
    </div>
    ${bottomTabBar}
  </div>
</body>
</html>`
}
