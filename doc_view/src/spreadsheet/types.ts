export interface ThemeColors {
  bg: string
  fg: string
  alt: string
}

export interface SpreadsheetCellModel {
  value: string
  colSpan?: number
  rowSpan?: number
  style?: string
}

export interface SpreadsheetRowModel {
  cells: (SpreadsheetCellModel | string | null | undefined)[]
  header?: string
}

export interface SpreadsheetColModel {
  widthPx?: number
}

export interface SpreadsheetSheetSpec {
  title: string
  banner?: string
  colgroupHtml?: string
  colHeadersHtml?: string
  tableRowsHtml?: string
  cols?: SpreadsheetColModel[]
  rows?: SpreadsheetRowModel[]
  maxColIdx?: number
}

export interface SpreadsheetLimits {
  MAX_SHEETS: number
  MAX_ROWS: number
  MAX_COLS: number
  MAX_SHARED_STRINGS: number
  MAX_XML_SIZE_BYTES: number
  MAX_TOTAL_HTML_BYTES: number
}

