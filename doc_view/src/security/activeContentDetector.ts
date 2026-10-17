import type { ActiveContentReport } from '../types.js'
import { tokenizeHtml, normalizeUrl } from './htmlParser.js'

const URL_ATTRIBUTES = new Set([
  'href', 'src', 'action', 'formaction', 'xlink:href', 'data', 'poster', 'background', 'codebase'
])

const EMBEDDED_ACTIVE_TAGS = new Set([
  'object', 'embed', 'applet', 'foreignobject', 'handler', 'listener'
])

export function isEventHandlerAttribute(name: string): boolean {
  const lower = name.toLowerCase().trim()
  return lower.startsWith('on') && lower.length > 2
}

export function isExecutableUrl(value: string): boolean {
  if (!value) return false
  const normalized = normalizeUrl(value).toLowerCase()
  return (
    normalized.startsWith('javascript:') ||
    normalized.startsWith('vbscript:') ||
    normalized.startsWith('data:text/html') ||
    normalized.startsWith('data:image/svg+xml')
  )
}

export function inspectActiveContent(content: string, format?: string): ActiveContentReport {
  const details: string[] = []
  let hasScriptTags = false
  let hasEventHandlers = false
  let hasJavascriptUrls = false
  let hasSvgActiveContent = false
  let hasEmbeddedObjects = false

  if (!content || typeof content !== 'string') {
    return {
      hasActiveContent: false,
      hasScriptTags: false,
      hasEventHandlers: false,
      hasJavascriptUrls: false,
      hasSvgActiveContent: false,
      hasEmbeddedObjects: false,
      details: [],
    }
  }

  try {
    const tokens = tokenizeHtml(content)
    let insideSvg = format === 'svg' || content.trim().startsWith('<svg')

    for (const token of tokens) {
      if (token.type === 'startTag') {
        const tag = token.tagName || ''
        if (tag === 'svg') insideSvg = true

        if (tag === 'script') {
          hasScriptTags = true
          const hasSrc = (token.attributes || []).some((a) => a.name === 'src')
          const desc = hasSrc ? '<script src="..."> (external script)' : '<script> (inline script)'
          if (insideSvg) {
            hasSvgActiveContent = true
            details.push(`SVG active element: ${desc}`)
          } else {
            details.push(desc)
          }
        }

        if (EMBEDDED_ACTIVE_TAGS.has(tag)) {
          hasEmbeddedObjects = true
          if (insideSvg && tag === 'foreignobject') {
            hasSvgActiveContent = true
            details.push(`SVG active element: <foreignObject>`)
          } else {
            details.push(`<${tag}> (embedded active object)`)
          }
        }

        if (token.attributes) {
          for (const attr of token.attributes) {
            if (isEventHandlerAttribute(attr.name)) {
              hasEventHandlers = true
              const desc = `Inline event handler: ${attr.name}="${attr.value}"`
              if (insideSvg) {
                hasSvgActiveContent = true
                details.push(`SVG event handler: ${desc}`)
              } else {
                details.push(desc)
              }
            }

            const isUrlAttr = URL_ATTRIBUTES.has(attr.name) || attr.name.endsWith(':href')
            if (isUrlAttr && isExecutableUrl(attr.value)) {
              hasJavascriptUrls = true
              const desc = `Executable URL in attribute: ${attr.name}="${attr.value}"`
              if (insideSvg) {
                hasSvgActiveContent = true
                details.push(`SVG executable URL: ${desc}`)
              } else {
                details.push(desc)
              }
            }

            if (tag === 'meta' && attr.name === 'http-equiv' && attr.value.toLowerCase() === 'refresh') {
              const contentAttr = token.attributes.find((a) => a.name === 'content')
              if (contentAttr && isExecutableUrl(contentAttr.value)) {
                hasJavascriptUrls = true
                details.push(`Meta refresh redirect to executable URL: ${contentAttr.value}`)
              }
            }

            if (tag === 'iframe' && attr.name === 'src' && isExecutableUrl(attr.value)) {
              hasJavascriptUrls = true
              details.push(`Iframe with active src: ${attr.value}`)
            }
          }
        }
      } else if (token.type === 'endTag') {
        if (token.tagName === 'svg') insideSvg = false
      }
    }
  } catch (err: any) {
    details.push(`Parser error on suspicious or malformed content: ${err?.message || err}`)
    return {
      hasActiveContent: true,
      hasScriptTags: true,
      hasEventHandlers: false,
      hasJavascriptUrls: false,
      hasSvgActiveContent: false,
      hasEmbeddedObjects: false,
      details,
    }
  }

  return {
    hasActiveContent: hasScriptTags || hasEventHandlers || hasJavascriptUrls || hasSvgActiveContent || hasEmbeddedObjects,
    hasScriptTags,
    hasEventHandlers,
    hasJavascriptUrls,
    hasSvgActiveContent,
    hasEmbeddedObjects,
    details,
  }
}