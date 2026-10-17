import { tokenizeHtml } from '../security/htmlParser.js'
import { isEventHandlerAttribute, isExecutableUrl } from '../security/activeContentDetector.js'

const STRIP_TAGS = new Set([
  'script', 'object', 'embed', 'applet', 'foreignobject', 'handler', 'listener'
])

const STRICT_CSP =
  '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data: https: http:; font-src data:; form-action \'none\';">'

export interface SanitizeOptions {
  allowInlineScripts?: boolean
}

export function sanitizeHtml(content: string, options?: SanitizeOptions): string {
  if (!content) return ''

  const allowInline = Boolean(options?.allowInlineScripts)
  const cspMeta = allowInline
    ? '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; style-src \'unsafe-inline\'; img-src data: https: http:; font-src data:; connect-src \'none\'; form-action \'none\';">'
    : STRICT_CSP

  const tokens = tokenizeHtml(content)
  const output: string[] = []
  let hasInjectedCsp = false
  let skippingTag: string | null = null
  let inScript = false
  let inStyle = false

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]

    if (skippingTag) {
      if (token.type === 'endTag' && token.tagName === skippingTag) {
        skippingTag = null
      }
      continue
    }

    if (token.type === 'doctype') {
      output.push(`<!DOCTYPE ${token.text || 'html'}>`)
      continue
    }
    if (token.type === 'comment') {
      output.push(`<!--${token.text || ''}-->`)
      continue
    }
    if (token.type === 'cdata') {
      output.push(`<![CDATA[${token.text || ''}]]>`)
      continue
    }

    if (token.type === 'text') {
      output.push(inScript || inStyle ? (token.text || '') : escapeText(token.text || ''))
      continue
    }

    if (token.type === 'endTag') {
      const tag = token.tagName || ''
      if (tag === 'script') {
        inScript = false
        if (allowInline) {
          output.push('</script>')
          continue
        }
      }
      if (tag === 'style') inStyle = false
      if (STRIP_TAGS.has(tag)) continue

      output.push(`</${tag}>`)
      continue
    }

    if (token.type === 'startTag') {
      const tag = token.tagName || ''

      if (tag === 'script' && allowInline) {
        const hasSrc = (token.attributes || []).some((a) => a.name.toLowerCase() === 'src')
        if (hasSrc) {
          if (!token.selfClosing) skippingTag = 'script'
          continue
        }
        inScript = true
        output.push('<script>')
        continue
      }

      if (tag === 'style') inStyle = true

      if (STRIP_TAGS.has(tag)) {
        if (!token.selfClosing) skippingTag = tag
        continue
      }

      const cleanAttrs: string[] = []
      if (token.attributes) {
        for (const attr of token.attributes) {
          if (isEventHandlerAttribute(attr.name) && !allowInline) continue

          let val = attr.value
          if (isExecutableUrl(val) && !allowInline) {
            val = '#disabled-javascript-link'
          }
          cleanAttrs.push(`${attr.name}="${escapeAttr(val)}"`)
        }
      }

      const attrStr = cleanAttrs.length > 0 ? ' ' + cleanAttrs.join(' ') : ''
      output.push(token.selfClosing ? `<${tag}${attrStr}/>` : `<${tag}${attrStr}>`)

      if (tag === 'head' && !hasInjectedCsp) {
        output.push('\n' + cspMeta + '\n')
        hasInjectedCsp = true
      }
    }
  }

  let result = output.join('')
  if (!hasInjectedCsp && result.includes('<html')) {
    result = result.replace(/<html[^>]*>/i, (m) => `${m}\n<head>${cspMeta}</head>`)
  } else if (!hasInjectedCsp) {
    result = `<head>${cspMeta}</head>\n${result}`
  }

  return result
}

function escapeText(text: string): string {
  return text.replace(/&(?!(?:[a-zA-Z0-9]+|#\d+|#x[0-9a-fA-F]+);)/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escapeAttr(val: string): string {
  return val.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}