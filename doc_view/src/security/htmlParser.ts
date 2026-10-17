export type HtmlTokenType = 'startTag' | 'endTag' | 'text' | 'comment' | 'doctype' | 'cdata'

export interface HtmlAttribute {
  name: string
  value: string
  rawName: string
  rawValue: string
}

export interface HtmlToken {
  type: HtmlTokenType
  tagName?: string
  attributes?: HtmlAttribute[]
  text?: string
  selfClosing?: boolean
  raw?: string
}

export interface HtmlNode {
  type: 'element' | 'text' | 'comment' | 'doctype'
  tagName?: string
  attributes?: Record<string, string>
  children?: HtmlNode[]
  text?: string
  selfClosing?: boolean
}

const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr'
])

const RAW_TEXT_ELEMENTS = new Set([
  'script', 'style', 'textarea', 'title', 'noscript'
])

const COMMON_NAMED_ENTITIES: Record<string, string> = {
  quot: '"', amp: '&', apos: "'", lt: '<', gt: '>', colon: ':',
  tab: '\t', newline: '\n', nbsp: '\u00A0', copy: '\u00A9', reg: '\u00AE',
  trade: '\u2122', sol: '/', bsol: '\\', period: '.', comma: ',',
  semi: ';', lpar: '(', rpar: ')',
}

export function decodeHtmlEntities(input: string): string {
  if (!input || !input.includes('&')) return input

  return input.replace(/&(#(?:x[0-9a-fA-F]+|[0-9]+)|[a-zA-Z0-9]+);?/g, (match, ent) => {
    if (ent.startsWith('#x') || ent.startsWith('#X')) {
      const cp = parseInt(ent.slice(2), 16)
      if (!isNaN(cp) && cp >= 0 && cp <= 0x10ffff) {
        try { return String.fromCodePoint(cp) } catch { }
      }
      return ''
    }

    if (ent.startsWith('#')) {
      const cp = parseInt(ent.slice(1), 10)
      if (!isNaN(cp) && cp >= 0 && cp <= 0x10ffff) {
        try { return String.fromCodePoint(cp) } catch { }
      }
      return ''
    }

    const lower = ent.toLowerCase()
    return COMMON_NAMED_ENTITIES[lower] !== undefined ? COMMON_NAMED_ENTITIES[lower] : match
  })
}

export function normalizeUrl(url: string): string {
  if (!url) return ''
  return decodeHtmlEntities(url).replace(/[\x00-\x20\t\r\n]+/g, '').trim()
}

export function tokenizeHtml(html: string): HtmlToken[] {
  const tokens: HtmlToken[] = []
  let cursor = 0
  const len = html.length

  while (cursor < len) {
    const nextLt = html.indexOf('<', cursor)
    if (nextLt === -1) {
      tokens.push({ type: 'text', text: html.slice(cursor) })
      break
    }

    if (nextLt > cursor) {
      tokens.push({ type: 'text', text: html.slice(cursor, nextLt) })
      cursor = nextLt
    }

    if (html.startsWith('<!--', cursor)) {
      const endComment = html.indexOf('-->', cursor + 4)
      if (endComment === -1) {
        tokens.push({ type: 'comment', text: html.slice(cursor + 4) })
        break
      }
      tokens.push({ type: 'comment', text: html.slice(cursor + 4, endComment) })
      cursor = endComment + 3
      continue
    }

    if (html.startsWith('<![CDATA[', cursor)) {
      const endCdata = html.indexOf(']]>', cursor + 9)
      if (endCdata === -1) {
        tokens.push({ type: 'cdata', text: html.slice(cursor + 9) })
        break
      }
      tokens.push({ type: 'cdata', text: html.slice(cursor + 9, endCdata) })
      cursor = endCdata + 3
      continue
    }

    if (html.startsWith('<!DOCTYPE', cursor) || html.startsWith('<!doctype', cursor)) {
      const endDoc = html.indexOf('>', cursor + 9)
      if (endDoc === -1) {
        tokens.push({ type: 'doctype', text: html.slice(cursor + 9).trim() })
        break
      }
      tokens.push({ type: 'doctype', text: html.slice(cursor + 9, endDoc).trim() })
      cursor = endDoc + 1
      continue
    }

    if (html.startsWith('</', cursor)) {
      const endTagEnd = html.indexOf('>', cursor + 2)
      if (endTagEnd === -1) {
        tokens.push({ type: 'endTag', tagName: html.slice(cursor + 2).trim().toLowerCase() })
        break
      }
      const tagContent = html.slice(cursor + 2, endTagEnd).trim()
      tokens.push({ type: 'endTag', tagName: tagContent.split(/[\s/]/)[0].toLowerCase() })
      cursor = endTagEnd + 1
      continue
    }

    cursor++
    let tagEnd = -1
    let inQuote: string | null = null
    let i = cursor

    while (i < len) {
      const c = html[i]
      if (inQuote) {
        if (c === inQuote) inQuote = null
      } else if (c === '"' || c === "'") {
        inQuote = c
      } else if (c === '>') {
        tagEnd = i
        break
      }
      i++
    }

    let tagContent = ''
    if (tagEnd === -1) {
      tagContent = html.slice(cursor)
      cursor = len
    } else {
      tagContent = html.slice(cursor, tagEnd)
      cursor = tagEnd + 1
    }

    const selfClosing = tagContent.endsWith('/')
    if (selfClosing) tagContent = tagContent.slice(0, -1)

    const firstSpace = tagContent.search(/[\s/]/)
    let tagName = ''
    let attrStr = ''

    if (firstSpace === -1) {
      tagName = tagContent.trim().toLowerCase()
    } else {
      tagName = tagContent.slice(0, firstSpace).trim().toLowerCase()
      attrStr = tagContent.slice(firstSpace)
    }

    if (!tagName) {
      tokens.push({ type: 'text', text: '<' + tagContent + (tagEnd !== -1 ? '>' : '') })
      continue
    }

    tokens.push({
      type: 'startTag',
      tagName,
      attributes: parseAttributes(attrStr),
      selfClosing: selfClosing || VOID_ELEMENTS.has(tagName),
      raw: '<' + tagContent + '>',
    })

    if (RAW_TEXT_ELEMENTS.has(tagName) && !selfClosing) {
      const closingPattern = new RegExp(`</${tagName}[\\s>]`, 'i')
      const match = html.slice(cursor).match(closingPattern)
      if (match && match.index !== undefined) {
        tokens.push({ type: 'text', text: html.slice(cursor, cursor + match.index) })
        cursor += match.index
      } else {
        tokens.push({ type: 'text', text: html.slice(cursor) })
        cursor = len
        break
      }
    }
  }

  return tokens
}

function parseAttributes(attrStr: string): HtmlAttribute[] {
  const attrs: HtmlAttribute[] = []
  if (!attrStr || !attrStr.trim()) return attrs

  let i = 0
  const n = attrStr.length

  while (i < n) {
    while (i < n && /\s/.test(attrStr[i])) i++
    if (i >= n) break

    const nameStart = i
    while (i < n && !/[\s=>/]/.test(attrStr[i])) i++
    const rawName = attrStr.slice(nameStart, i)
    if (!rawName) {
      i++
      continue
    }

    const name = rawName.toLowerCase()
    while (i < n && /\s/.test(attrStr[i])) i++

    if (i >= n || attrStr[i] !== '=') {
      attrs.push({ name, value: '', rawName, rawValue: '' })
      continue
    }

    i++
    while (i < n && /\s/.test(attrStr[i])) i++
    if (i >= n) {
      attrs.push({ name, value: '', rawName, rawValue: '' })
      break
    }

    const quote = attrStr[i]
    let rawValue = ''
    if (quote === '"' || quote === "'") {
      i++
      const valStart = i
      while (i < n && attrStr[i] !== quote) i++
      rawValue = attrStr.slice(valStart, i)
      if (i < n && attrStr[i] === quote) i++
    } else {
      const valStart = i
      while (i < n && !/[\s>]/.test(attrStr[i])) i++
      rawValue = attrStr.slice(valStart, i)
    }

    attrs.push({
      name,
      value: decodeHtmlEntities(rawValue),
      rawName,
      rawValue,
    })
  }

  return attrs
}

export function parseHtml(html: string): HtmlNode {
  const tokens = tokenizeHtml(html)
  const root: HtmlNode = { type: 'element', tagName: 'root', children: [] }
  const stack: HtmlNode[] = [root]

  for (const token of tokens) {
    const current = stack[stack.length - 1]

    if (token.type === 'text' || token.type === 'comment' || token.type === 'doctype') {
      current.children = current.children || []
      current.children.push({ type: token.type, text: token.text })
    } else if (token.type === 'startTag') {
      const attrs: Record<string, string> = {}
      if (token.attributes) {
        for (const attr of token.attributes) attrs[attr.name] = attr.value
      }

      const elementNode: HtmlNode = {
        type: 'element',
        tagName: token.tagName,
        attributes: attrs,
        children: [],
        selfClosing: token.selfClosing,
      }

      current.children = current.children || []
      current.children.push(elementNode)

      if (!token.selfClosing && token.tagName && !VOID_ELEMENTS.has(token.tagName)) {
        stack.push(elementNode)
      }
    } else if (token.type === 'endTag') {
      const closeTag = token.tagName
      if (!closeTag) continue

      let foundIndex = -1
      for (let s = stack.length - 1; s >= 1; s--) {
        if (stack[s].tagName === closeTag) {
          foundIndex = s
          break
        }
      }
      if (foundIndex !== -1) stack.length = foundIndex
    }
  }

  return root
}

export function serializeHtml(node: HtmlNode | HtmlNode[]): string {
  if (Array.isArray(node)) return node.map((n) => serializeHtml(n)).join('')
  if (node.type === 'text') return escapeHtmlText(node.text || '')
  if (node.type === 'comment') return `<!--${node.text || ''}-->`
  if (node.type === 'doctype') return `<!DOCTYPE ${node.text || 'html'}>`

  if (node.type === 'element') {
    if (node.tagName === 'root') return (node.children || []).map((c) => serializeHtml(c)).join('')

    const tag = node.tagName || 'div'
    const attrParts: string[] = []
    if (node.attributes) {
      for (const [k, v] of Object.entries(node.attributes)) {
        attrParts.push(`${k}="${escapeHtmlAttribute(v)}"`)
      }
    }
    const attrStr = attrParts.length > 0 ? ' ' + attrParts.join(' ') : ''

    if (VOID_ELEMENTS.has(tag) || node.selfClosing) return `<${tag}${attrStr}>`
    const inner = (node.children || []).map((c) => serializeHtml(c)).join('')
    return `<${tag}${attrStr}>${inner}</${tag}>`
  }

  return ''
}

function escapeHtmlText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escapeHtmlAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}