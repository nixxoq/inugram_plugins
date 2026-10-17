export interface NumberFormatOptions {
  numFmtId?: number | string
  formatCode?: string
}

export function formatScientific(num: number, decimals = 2): string {
  if (isNaN(num) || !isFinite(num)) return String(num)
  const parts = num.toExponential(decimals).toUpperCase().split('E')
  if (parts.length === 2) {
    let exp = parts[1]
    const sign = exp.startsWith('-') ? '-' : '+'
    if (exp.startsWith('+') || exp.startsWith('-')) exp = exp.slice(1)
    return `${parts[0]}E${sign}${exp.padStart(2, '0')}`
  }
  return num.toExponential(decimals).toUpperCase()
}

export function formatExcelDate(val: number | string): string {
  const days = typeof val === 'number' ? val : parseFloat(val)
  if (isNaN(days)) return String(val)

  const d = new Date((days - 25569) * 86400 * 1000)
  if (isNaN(d.getTime())) return String(val)

  const yr = d.getUTCFullYear()
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0')
  const da = String(d.getUTCDate()).padStart(2, '0')
  const hr = String(d.getUTCHours()).padStart(2, '0')
  const mi = String(d.getUTCMinutes()).padStart(2, '0')
  const sec = String(d.getUTCSeconds()).padStart(2, '0')

  if (days === Math.floor(days)) return `${yr}-${mo}-${da}`
  if (days < 1) return sec === '00' ? `${hr}:${mi}` : `${hr}:${mi}:${sec}`
  return `${yr}-${mo}-${da} ${hr}:${mi}`
}

export function formatNumberWithCommas(num: number, decimals: number): string {
  const parts = num.toFixed(decimals).split('.')
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return parts.join('.')
}

export function isExcelDateFormat(numFmtId: number, formatCode?: string): boolean {
  if (
    (numFmtId >= 14 && numFmtId <= 22) ||
    (numFmtId >= 27 && numFmtId <= 36) ||
    (numFmtId >= 45 && numFmtId <= 47) ||
    (numFmtId >= 50 && numFmtId <= 58)
  ) {
    return true
  }
  if (formatCode) {
    return /[ymdhs]/i.test(formatCode.replace(/"[^"]*"|\\.|\[[^\]]*\]/g, ''))
  }
  return false
}

export function formatCellValue(value: any, options?: NumberFormatOptions): string {
  if (value === null || value === undefined || value === '') return ''
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE'
  if (typeof value === 'string' && isNaN(Number(value))) return value

  const num = typeof value === 'number' ? value : Number(value)
  if (isNaN(num)) return String(value)

  const numFmtId = options?.numFmtId !== undefined ? Number(options.numFmtId) : 0
  const formatCode = options?.formatCode || ''

  if (isExcelDateFormat(numFmtId, formatCode)) return formatExcelDate(num)

  // 0: General
  // 1: 0
  // 2: 0.00
  // 3: #,##0
  // 4: #,##0.00
  // 9: 0%
  // 10: 0.00%
  // 11: 0.00E+00
  // 12: ##0.0E+0
  switch (numFmtId) {
    case 0:
      if (Number.isInteger(num)) return String(num)
      if (Math.abs(num) < 1e-6 || Math.abs(num) >= 1e11) return formatScientific(num, 2)
      return String(parseFloat(num.toFixed(8)))
    case 1: return String(Math.round(num))
    case 2: return num.toFixed(2)
    case 3: return formatNumberWithCommas(Math.round(num), 0)
    case 4: return formatNumberWithCommas(num, 2)
    case 9: return `${Math.round(num * 100)}%`
    case 10: return `${(num * 100).toFixed(2)}%`
    case 11: return formatScientific(num, 2)
    case 12: return formatScientific(num, 1)
  }

  if (formatCode) {
    if (/E[+-]/i.test(formatCode)) {
      const match = formatCode.match(/0\.([0]+)E/i)
      return formatScientific(num, match ? match[1].length : 2)
    }
    if (formatCode.includes('%')) {
      const match = formatCode.match(/0\.([0]+)%/)
      return `${(num * 100).toFixed(match ? match[1].length : 0)}%`
    }
    if (formatCode.includes('0.00')) {
      return formatCode.includes('#,') ? formatNumberWithCommas(num, 2) : num.toFixed(2)
    }
    if (formatCode.includes('0.0')) return num.toFixed(1)
    if (formatCode.includes('#,##0')) return formatNumberWithCommas(Math.round(num), 0)
  }

  if (Number.isInteger(num)) return String(num)
  if (Math.abs(num) < 1e-5 || Math.abs(num) >= 1e11) return formatScientific(num, 2)
  return String(parseFloat(num.toFixed(8)))
}