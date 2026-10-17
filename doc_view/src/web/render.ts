import { escapeHtml } from '../utils/html.js'

const MD_FENCE = /^\s*(```|~~~)/
const MD_HEAD = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/
const MD_HR = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/
const MD_LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/
const MD_TSEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/
const MD_URL = /^(https?:\/\/|mailto:|tg:\/\/|#)/i

function mdLink(_: string, text: string, url: string): string {
  return MD_URL.test(url) ? `<a href="${url.replace(/"/g, '%22')}">${text}</a>` : text
}

function mdAutolink(_: string, url: string): string {
  let cleanUrl = url
  let tail = ''
  while (cleanUrl && '.,;:!?)'.includes(cleanUrl[cleanUrl.length - 1])) {
    tail = cleanUrl[cleanUrl.length - 1] + tail
    cleanUrl = cleanUrl.slice(0, -1)
  }
  return `<a href="${cleanUrl}">${cleanUrl}</a>${tail}`
}

function mdInline(s: string): string {
  let escaped = escapeHtml(s)
  const codes: string[] = []

  escaped = escaped.replace(/`([^`]+)`/g, (_, code) => {
    codes.push(code)
    return `\x00${codes.length - 1}\x00`
  })

  escaped = escaped.replace(/!\[([^\]]*)\]\([^)]*\)/g, '<em>[$1]</em>')
  escaped = escaped.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, mdLink)
  escaped = escaped.replace(/(?<![">=/])(https?:\/\/[^\s<]+)/g, mdAutolink)
  escaped = escaped.replace(/\*\*(.+?)\*\*|__(.+?)__/g, (_, a, b) => `<strong>${a || b}</strong>`)
  escaped = escaped.replace(/(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])/g, '<em>$1</em>')
  escaped = escaped.replace(/(?<![\w_])_(?!\s)(.+?)(?<!\s)_(?![\w_])/g, '<em>$1</em>')
  escaped = escaped.replace(/~~(.+?)~~/g, '<del>$1</del>')

  return escaped.replace(/\x00(\d+)\x00/g, (_, idx) => `<code>${codes[parseInt(idx, 10)]}</code>`)
}

function mdCells(line: string): string[] {
  let l = line.trim()
  if (l.startsWith('|')) l = l.slice(1)
  if (l.endsWith('|')) l = l.slice(0, -1)
  return l.split(/(?<!\\)\|/).map((c) => c.trim())
}

function mdTable(head: string[], rows: string[][]): string {
  const out = ['<div class="t"><table><thead><tr>']
  for (const c of head) out.push(`<th>${mdInline(c)}</th>`)
  out.push('</tr></thead><tbody>')
  for (const r of rows) out.push('<tr>' + r.map((c) => `<td>${mdInline(c)}</td>`).join('') + '</tr>')
  out.push('</tbody></table></div>')
  return out.join('')
}

function mdBlocks(lines: string[]): string {
  const out: string[] = []
  const para: string[] = []
  let i = 0
  const n = lines.length

  function flush(): void {
    if (para.length > 0) {
      out.push(`<p>${mdInline(para.join('\n')).replace(/ {2,}\n/g, '<br>\n')}</p>`)
      para.length = 0
    }
  }

  while (i < n) {
    const line = lines[i]
    const fence = line.match(MD_FENCE)
    if (fence) {
      flush()
      const marker = fence[1]
      const code: string[] = []
      i++
      while (i < n && !lines[i].trim().startsWith(marker)) {
        code.push(lines[i])
        i++
      }
      i++
      out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`)
      continue
    }

    if (!line.trim()) {
      flush()
      i++
      continue
    }

    const headMatch = line.match(MD_HEAD)
    if (headMatch) {
      flush()
      out.push(`<h${headMatch[1].length}>${mdInline(headMatch[2])}</h${headMatch[1].length}>`)
      i++
      continue
    }

    if (MD_HR.test(line)) {
      flush()
      out.push('<hr>')
      i++
      continue
    }

    if (line.trimStart().startsWith('>')) {
      flush()
      const quote: string[] = []
      while (i < n && lines[i].trimStart().startsWith('>')) {
        quote.push(lines[i].replace(/^\s*>\s?/, ''))
        i++
      }
      out.push(`<blockquote>${mdBlocks(quote)}</blockquote>`)
      continue
    }

    if (line.includes('|') && i + 1 < n && lines[i + 1].includes('-') && MD_TSEP.test(lines[i + 1])) {
      flush()
      const head = mdCells(line)
      i += 2
      const rows: string[][] = []
      while (i < n && lines[i].trim() && lines[i].includes('|')) {
        rows.push(mdCells(lines[i]))
        i++
      }
      out.push(mdTable(head, rows))
      continue
    }

    const listMatch = line.match(MD_LIST)
    if (listMatch) {
      flush()
      const indent = listMatch[1].replace(/\t/g, '    ').length
      const bullet = ['-', '*', '+'].includes(listMatch[2]) ? '•' : listMatch[2]
      const item = listMatch[3].replace(/^\[( |x|X)\]\s+/, (_, c) => (c === ' ' ? '☐ ' : '☑ '))
      out.push(`<p class="li" style="margin-left:${indent * 8}px"><span>${bullet}</span> ${mdInline(item)}</p>`)
      i++
      continue
    }

    para.push(line.trimStart())
    i++
  }

  flush()
  return out.join('\n')
}

export interface WebTheme {
  bg: string
  fg: string
  alt: string
}

export function buildMarkdownHtml(text: string, theme: WebTheme): string {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const body = mdBlocks(normalized.split('\n'))

  const css = `
html, body { margin: 0; background: ${theme.bg}; color: ${theme.fg}; }
body { font: 16px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding: 18px; word-wrap: break-word; overflow-wrap: anywhere; }
h1, h2, h3, h4, h5, h6 { line-height: 1.3; margin: 1.2em 0 .5em; }
h1, h2 { border-bottom: 1px solid ${theme.alt}; padding-bottom: .25em; }
a { color: #4da3ff; text-decoration: none; }
hr { border: 0; border-top: 1px solid ${theme.alt}; margin: 1.5em 0; }
code { background: ${theme.alt}; padding: .15em .35em; border-radius: 4px; font-family: monospace, monospace; font-size: .92em; }
pre { background: ${theme.alt}; padding: 14px; border-radius: 8px; overflow-x: auto; }
pre code { background: none; padding: 0; }
blockquote { margin: .8em 0; padding: 0 0 0 14px; border-left: 4px solid ${theme.alt}; opacity: .88; }
.t { overflow-x: auto; margin: 1em 0; }
table { border-collapse: collapse; width: 100%; }
td, th { border: 1px solid ${theme.alt}; padding: 8px 12px; }
th { background: ${theme.alt}; font-weight: bold; }
.li { margin-top: .3em; margin-bottom: .3em; }
.li span { display: inline-block; min-width: 1.2em; }
`

  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'none';">
<style>${css}</style></head><body>${body}</body></html>`
}

export function buildSvgHtml(svgText: string): string {
  const svg = svgText.replace(/<\?xml.*?\?>|<!DOCTYPE[^>\[]*(\[[^\]]*\])?\s*>/gis, '').trim()

  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; form-action 'none';">
<style>
html, body { margin: 0; padding: 12px; background: #ffffff; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
svg { display: block; max-width: 100%; height: auto; margin: 0 auto; }
</style></head><body>${svg}</body></html>`
}