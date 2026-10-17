import type { PaginatedDoc } from '../types.js'
import { paginate } from '../viewer/text/textReader.js'
import { escapeHtml } from '../utils/html.js'
import { renderOfficeHtmlShell } from './render.js'
import { t } from '../i18n/index.js'

const MAX_RTF_BYTES = 8 * 1024 * 1024

const RTF_TOKEN =
  /\\([a-zA-Z]+)(-?\d+)? ?|\\'([0-9a-fA-F]{2})|\\([^a-zA-Z0-9])|([{}]|[^\\{}\r\n]+|[\r\n]+)/g

const RTF_SKIP = new Set([
  'info', 'pict', 'header', 'footer', 'headerl', 'headerr',
  'headerf', 'footerl', 'footerr', 'footerf', 'footnote', 'themedata', 'colorschememapping',
  'latentstyles', 'datastore', 'xmlnstbl', 'listtable', 'listoverridetable', 'rsidtbl',
  'generator', 'object', 'fldinst', 'bkmkstart', 'bkmkend', 'revtbl', 'pgptbl', 'private',
  'template', 'filetbl', 'nonshppict', 'falt', 'panose',
])

const RTF_CHARS: Record<string, string> = {
  emdash: '—', endash: '–', bullet: '•', lquote: '‘', rquote: '’',
  ldblquote: '“', rdblquote: '”', emspace: ' ', enspace: ' ', qmspace: ' ',
}

const RTF_SYMBOLS: Record<string, string> = {
  '~': '\u00a0', _: '‑', '-': '', '\\': '\\', '{': '{', '}': '}',
}

interface RtfState {
  bold: boolean
  italic: boolean
  underline: boolean
  strike: boolean
  align: 'left' | 'center' | 'right' | 'justify'
  firstLineIndentPt: number
  fontSizePt: number
  fontIndex: number
  colorIndex: number
}

function decodeBytesWithCodepage(bytes: number[], codepage: string): string {
  try {
    if (typeof inu !== 'undefined' && inu?.jvm) {
      const StringCls = inu.jvm.cls('java.lang.String')
      const ArrayCls = inu.jvm.cls('java.lang.reflect.Array')
      const javaArr = ArrayCls.callStatic('newInstance', inu.jvm.cls('java.lang.Byte').getStaticField('TYPE'), bytes.length) as JavaObject

      for (let i = 0; i < bytes.length; i++) {
        ArrayCls.callStatic('setByte', javaArr, i, (bytes[i] << 24) >> 24)
      }

      let encoding = codepage
      if (/^cp\d+$/i.test(codepage)) encoding = `windows-${codepage.slice(2)}`
      return String(new StringCls(javaArr, encoding))
    }
  } catch { }

  try {
    let encoding = codepage.toLowerCase()
    if (encoding.startsWith('cp')) encoding = `windows-${encoding.slice(2)}`
    if (encoding.includes('1251')) encoding = 'windows-1251'
    else if (encoding.includes('1252')) encoding = 'windows-1252'
    return new (TextDecoder as any)(encoding).decode(new Uint8Array(bytes))
  } catch {
    return String.fromCharCode(...bytes)
  }
}

export function parseRtfToHtml(raw: string, theme: { bg: string; fg: string; alt: string }): string {
  const mAnsicpg = raw.match(/\\ansicpg(\d+)/)
  const codepage = mAnsicpg ? `cp${mAnsicpg[1]}` : 'cp1252'

  const colorTable: string[] = []
  const colortblMatch = raw.match(/\\colortbl\s*;?([^}]+)}/)
  if (colortblMatch) {
    for (const c of colortblMatch[1].split(';')) {
      const rm = c.match(/\\red(\d+)/)
      const gm = c.match(/\\green(\d+)/)
      const bm = c.match(/\\blue(\d+)/)
      colorTable.push(rm && gm && bm ? `rgb(${rm[1]}, ${gm[1]}, ${bm[1]})` : '')
    }
  }

  const fontTable: Record<number, string> = {}
  const fonttblMatch = raw.match(/\{\\fonttbl([\s\S]*?)\}(?=\{|\\)/)
  if (fonttblMatch) {
    const fontDefs = fonttblMatch[1].match(/\\f(\d+)[^;]*?\s+([^;]+);/g)
    if (fontDefs) {
      for (const fd of fontDefs) {
        const m = fd.match(/\\f(\d+)[^;]*?\s+([^;]+);/)
        if (m) fontTable[parseInt(m[1], 10)] = m[2].trim()
      }
    }
  }

  const defaultState: RtfState = {
    bold: false,
    italic: false,
    underline: false,
    strike: false,
    align: 'left',
    firstLineIndentPt: 0,
    fontSizePt: 14,
    fontIndex: 0,
    colorIndex: 0,
  }

  const stateStack: RtfState[] = [{ ...defaultState }]
  let currState: RtfState = { ...defaultState }

  const paragraphs: Array<{ align: string; firstLinePt: number; html: string }> = []
  let currentRuns: string[] = []
  let inTable = false
  const tableRows: string[][] = []
  let currentRowCells: string[] = []

  let skipDepth = 0
  let uc = 1
  let pending = 0
  const hexbuf: number[] = []

  function flushHex(): void {
    if (hexbuf.length > 0) {
      appendRunText(decodeBytesWithCodepage(hexbuf, codepage))
      hexbuf.length = 0
    }
  }

  function appendRunText(text: string): void {
    if (!text) return
    let styled = escapeHtml(text)
    if (currState.bold) styled = `<strong>${styled}</strong>`
    if (currState.italic) styled = `<em>${styled}</em>`
    if (currState.underline) styled = `<u>${styled}</u>`
    if (currState.strike) styled = `<s>${styled}</s>`

    const css: string[] = []
    if (currState.fontSizePt && currState.fontSizePt !== 14) css.push(`font-size: ${currState.fontSizePt}pt`)
    if (currState.colorIndex > 0 && colorTable[currState.colorIndex - 1]) css.push(`color: ${colorTable[currState.colorIndex - 1]}`)
    if (fontTable[currState.fontIndex]) css.push(`font-family: '${fontTable[currState.fontIndex]}', serif`)

    currentRuns.push(css.length > 0 ? `<span style="${css.join('; ')}">${styled}</span>` : styled)
  }

  function flushParagraph(): void {
    flushHex()
    const content = currentRuns.join('')
    currentRuns = []
    if (inTable) {
      currentRowCells.push(content)
    } else if (content.trim()) {
      paragraphs.push({ align: currState.align, firstLinePt: currState.firstLineIndentPt, html: content })
    }
  }

  RTF_TOKEN.lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = RTF_TOKEN.exec(raw)) !== null) {
    const [_, word, num, hx, sym, other] = match

    if (skipDepth > 0) {
      if (other === '{') skipDepth++
      else if (other === '}') skipDepth--
      continue
    }

    if (other === '{') {
      flushHex()
      stateStack.push({ ...currState })
    } else if (other === '}') {
      flushHex()
      if (stateStack.length > 1) currState = stateStack.pop()!
    } else if (word) {
      if (RTF_SKIP.has(word) || word === 'fonttbl' || word === 'colortbl' || word === 'stylesheet') {
        skipDepth = 1
        continue
      }

      flushHex()
      if (word === 'pard') {
        currState.align = 'left'
        currState.firstLineIndentPt = 0
      } else if (word === 'b') currState.bold = num !== '0'
      else if (word === 'i') currState.italic = num !== '0'
      else if (word === 'ul') currState.underline = true
      else if (word === 'ulnone') currState.underline = false
      else if (word === 'strike') currState.strike = num !== '0'
      else if (word === 'qc') currState.align = 'center'
      else if (word === 'qj') currState.align = 'justify'
      else if (word === 'qr') currState.align = 'right'
      else if (word === 'ql') currState.align = 'left'
      else if (word === 'fi') currState.firstLineIndentPt = Math.round((parseInt(num || '0', 10) / 20.0) * 10) / 10
      else if (word === 'fs') currState.fontSizePt = Math.round(parseInt(num || '28', 10) / 2.0)
      else if (word === 'f') currState.fontIndex = parseInt(num || '0', 10)
      else if (word === 'cf') currState.colorIndex = parseInt(num || '0', 10)
      else if (word === 'par' || word === 'sect') flushParagraph()
      else if (word === 'trowd') { flushParagraph(); inTable = true }
      else if (word === 'cell') { flushHex(); currentRowCells.push(currentRuns.join('')); currentRuns = [] }
      else if (word === 'row') {
        flushHex()
        if (currentRowCells.length > 0) {
          tableRows.push([...currentRowCells])
          currentRowCells = []
        }
      } else if (word === 'tab') currentRuns.push('<span style="display:inline-block;min-width:2em">&emsp;</span>')
      else if (word === 'line') currentRuns.push('<br>')
      else if (word === 'uc') uc = parseInt(num || '1', 10)
      else if (word === 'u' && num) {
        appendRunText(String.fromCharCode(parseInt(num, 10) & 0xffff))
        pending = uc
      } else if (RTF_CHARS[word]) appendRunText(RTF_CHARS[word])
    } else if (hx !== undefined) {
      if (pending > 0) pending--
      else hexbuf.push(parseInt(hx, 16))
    } else if (sym) {
      if (sym === '*') skipDepth = 1
      else if (RTF_SYMBOLS[sym] !== undefined) appendRunText(RTF_SYMBOLS[sym])
    } else if (other) {
      let tStr = other
      if (pending > 0) {
        const cut = Math.min(pending, tStr.length)
        tStr = tStr.slice(cut)
        pending -= cut
      }
      if (tStr) appendRunText(tStr)
    }
  }

  flushParagraph()

  const bodyHtmlChunks: string[] = []
  for (const p of paragraphs) {
    const css: string[] = []
    if (p.align && p.align !== 'left') css.push(`text-align: ${p.align}`)
    if (p.firstLinePt > 0) css.push(`text-indent: ${p.firstLinePt}pt`)
    const styleAttr = css.length > 0 ? ` style="${css.join('; ')}"` : ''
    bodyHtmlChunks.push(`<p class="rtf-p"${styleAttr}>${p.html}</p>`)
  }

  if (tableRows.length > 0) {
    const rowsHtml = tableRows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('\n')
    bodyHtmlChunks.push(`<div class="rtf-table-wrap"><table class="rtf-table"><tbody>${rowsHtml}</tbody></table></div>`)
  }

  const extraCss = `
.rtf-p { margin: 0 0 4pt 0; }
table.rtf-table { border-collapse: collapse; width: 100%; margin: 10pt 0; }
table.rtf-table td, table.rtf-table th { border: 1px solid ${theme.alt}; padding: 6px 10px; }
.rtf-table-wrap { overflow-x: auto; margin: 8pt 0; }
`

  return renderOfficeHtmlShell({
    bodyHtml: bodyHtmlChunks.join('\n') || `<p>${t('office.emptyDoc')}</p>`,
    theme,
    containerClass: 'rtf-container',
    extraCss,
  })
}

function readRtfRaw(filePath: string): string {
  if (typeof inu !== 'undefined' && inu?.jvm) {
    let isr: JavaObject | null = null
    try {
      const fis = new (inu.jvm.cls('java.io.FileInputStream'))(new (inu.jvm.cls('java.io.File'))(filePath))
      isr = new (inu.jvm.cls('java.io.InputStreamReader'))(fis, 'ISO-8859-1')
      const ArrayCls = inu.jvm.cls('java.lang.reflect.Array')
      const StringCls = inu.jvm.cls('java.lang.String')
      const charBuf = ArrayCls.callStatic('newInstance', inu.jvm.cls('java.lang.Character').getStaticField('TYPE'), 16384) as JavaObject
      const chunks: string[] = []
      let totalRead = 0

      while (true) {
        const count = Number(isr.call('read', charBuf, 0, 16384))
        if (count <= 0) break
        chunks.push(String(StringCls.callStatic('valueOf', charBuf, 0, count)))
        totalRead += count
        if (totalRead >= MAX_RTF_BYTES) break
      }
      return chunks.join('')
    } finally {
      try { isr?.call('close') } catch { }
    }
  }
  return ''
}

export function buildRtfHtml(filePath: string, theme: { bg: string; fg: string; alt: string }): string {
  return parseRtfToHtml(readRtfRaw(filePath), theme)
}

function parseRtfText(raw: string): string {
  const mAnsicpg = raw.match(/\\ansicpg(\d+)/)
  const codepage = mAnsicpg ? `cp${mAnsicpg[1]}` : 'cp1252'

  const out: string[] = []
  let skip = false
  let uc = 1
  let pending = 0
  const hexbuf: number[] = []

  function flush(): void {
    if (hexbuf.length > 0) {
      out.push(decodeBytesWithCodepage(hexbuf, codepage))
      hexbuf.length = 0
    }
  }

  RTF_TOKEN.lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = RTF_TOKEN.exec(raw)) !== null) {
    const [_, word, num, hx, sym, other] = match

    if (skip) {
      if (other === '}') skip = false
      continue
    }

    if (other === '{' || other === '}') {
      flush()
    } else if (word) {
      if (RTF_SKIP.has(word)) skip = true
      else if (['par', 'sect', 'page', 'line'].includes(word)) out.push('\n')
      else if (word === 'tab') out.push('\t')
      else if (word === 'uc') uc = parseInt(num || '1', 10)
      else if (word === 'u' && num) {
        out.push(String.fromCharCode(parseInt(num, 10) & 0xffff))
        pending = uc
      } else if (RTF_CHARS[word]) out.push(RTF_CHARS[word])
    } else if (hx !== undefined) {
      if (pending > 0) pending--
      else hexbuf.push(parseInt(hx, 16))
    } else if (sym) {
      if (sym === '*') skip = true
      else if (RTF_SYMBOLS[sym] !== undefined) out.push(RTF_SYMBOLS[sym])
    } else if (other) {
      let tStr = other
      if (pending > 0) {
        const cut = Math.min(pending, tStr.length)
        tStr = tStr.slice(cut)
        pending -= cut
      }
      out.push(tStr)
    }
  }

  flush()
  return out.join('').replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

export async function parseRtfDocument(filePath: string): Promise<PaginatedDoc> {
  const text = parseRtfText(readRtfRaw(filePath)) || t('office.emptyDoc')
  return {
    pages: paginate(text),
    font: 0,
    wrap: true,
  }
}