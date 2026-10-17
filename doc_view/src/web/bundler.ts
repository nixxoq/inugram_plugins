import { readZipEntryText, readZipEntryBase64 } from '../archive/zip/helper.js'
import { readTextDocumentAsync } from '../viewer/text/textReader.js'

export interface HtmlBundleContext {
  filePath?: string
  archiveContext?: {
    archivePath: string
    entryPath: string
    archivePassword?: string
    charset?: string
  }
}

export function isLocalRelativeUrl(url: string): boolean {
  if (!url) return false
  const trimmed = url.trim()
  return !(
    !trimmed ||
    trimmed.startsWith('http:') ||
    trimmed.startsWith('https:') ||
    trimmed.startsWith('//') ||
    trimmed.startsWith('data:') ||
    trimmed.startsWith('blob:') ||
    trimmed.startsWith('javascript:') ||
    trimmed.startsWith('vbscript:') ||
    trimmed.startsWith('mailto:') ||
    trimmed.startsWith('about:') ||
    trimmed.startsWith('#')
  )
}

export function resolveRelativePath(baseDir: string, relativePath: string): string {
  let clean = relativePath.split(/[?#]/)[0].trim().replace(/\\/g, '/')
  const isAbsolute = baseDir.startsWith('/')
  if (clean.startsWith('/')) clean = clean.slice(1)

  const parts = (baseDir ? baseDir.split('/') : []).filter(Boolean)
  for (const seg of clean.split('/')) {
    if (seg === '.' || seg === '') continue
    if (seg === '..') {
      if (parts.length > 0) parts.pop()
    } else {
      parts.push(seg)
    }
  }

  const res = parts.join('/')
  return isAbsolute ? '/' + res : res
}

function getMimeTypeFromExt(ext: string): string {
  switch (ext.toLowerCase()) {
    case 'png': return 'image/png'
    case 'jpg':
    case 'jpeg': return 'image/jpeg'
    case 'gif': return 'image/gif'
    case 'webp': return 'image/webp'
    case 'svg': return 'image/svg+xml'
    case 'css': return 'text/css'
    case 'js': return 'application/javascript'
    default: return 'application/octet-stream'
  }
}

function readLocalBinaryBase64(filePath: string): string | null {
  if (typeof inu !== 'undefined' && inu?.jvm) {
    try {
      const FileCls = inu.jvm.cls('java.io.File')
      const FilesCls = inu.jvm.cls('java.nio.file.Files')
      const Base64Cls = inu.jvm.cls('android.util.Base64')
      const file = new FileCls(filePath)
      if (!Boolean(file.call('exists'))) return null
      const bytes = FilesCls.callStatic('readAllBytes', file.call('toPath')) as JavaObject
      return String(Base64Cls.callStatic('encodeToString', bytes, Number(Base64Cls.getStaticField('NO_WRAP'))))
    } catch {
      return null
    }
  }
  return null
}

async function readResourceText(targetPath: string, context: HtmlBundleContext): Promise<string | null> {
  if (context.archiveContext) {
    return readZipEntryText(
      context.archiveContext.archivePath,
      targetPath,
      2 * 1024 * 1024,
      context.archiveContext.charset
    )
  }
  if (context.filePath) {
    try {
      const doc = await readTextDocumentAsync(targetPath)
      return doc?.pages ? doc.pages.join('') : null
    } catch {
      return null
    }
  }
  return null
}

function readResourceBase64(targetPath: string, context: HtmlBundleContext): string | null {
  if (context.archiveContext) {
    return readZipEntryBase64(context.archiveContext.archivePath, targetPath, 10 * 1024 * 1024)
  }
  if (context.filePath) {
    return readLocalBinaryBase64(targetPath)
  }
  return null
}

export async function bundleHtmlResources(html: string, context?: HtmlBundleContext): Promise<string> {
  if (!html || !context || (!context.filePath && !context.archiveContext)) {
    return html
  }

  let baseDir = ''
  if (context.archiveContext) {
    const entryPath = context.archiveContext.entryPath.replace(/\\/g, '/')
    const slashIdx = entryPath.lastIndexOf('/')
    baseDir = slashIdx !== -1 ? entryPath.slice(0, slashIdx) : ''
  } else if (context.filePath) {
    const norm = context.filePath.replace(/\\/g, '/')
    const slashIdx = norm.lastIndexOf('/')
    baseDir = slashIdx !== -1 ? norm.slice(0, slashIdx) : '.'
  }

  let result = html

  const scriptRegex = /<script\b([^>]*)>(?:([\s\S]*?)<\/script>)?|<script\b([^>]*)\/>/gi
  const scriptMatches: Array<{ fullMatch: string; attrs: string }> = []
  let sMatch: RegExpExecArray | null
  while ((sMatch = scriptRegex.exec(html)) !== null) {
    scriptMatches.push({ fullMatch: sMatch[0], attrs: sMatch[1] || sMatch[3] || '' })
  }

  for (const item of scriptMatches) {
    const srcMatch = /\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i.exec(item.attrs)
    if (!srcMatch) continue
    const src = srcMatch[1] || srcMatch[2] || srcMatch[3]
    if (!src || !isLocalRelativeUrl(src)) continue

    const targetPath = resolveRelativePath(baseDir, src)
    const scriptContent = await readResourceText(targetPath, context)
    if (scriptContent !== null) {
      const safeContent = scriptContent.replace(/<\/script>/gi, '<\\/script>')
      result = result.replace(item.fullMatch, () => `<script>\n/* inlined: ${src} */\n${safeContent}\n</script>`)
    }
  }

  const linkRegex = /<link\b([^>]*)\/?>/gi
  const linkMatches: Array<{ fullMatch: string; attrs: string }> = []
  let lMatch: RegExpExecArray | null
  while ((lMatch = linkRegex.exec(result)) !== null) {
    linkMatches.push({ fullMatch: lMatch[0], attrs: lMatch[1] || '' })
  }

  for (const item of linkMatches) {
    const relMatch = /\brel\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i.exec(item.attrs)
    if (!relMatch || !(relMatch[1] || relMatch[2] || relMatch[3] || '').toLowerCase().includes('stylesheet')) continue

    const hrefMatch = /\bhref\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i.exec(item.attrs)
    if (!hrefMatch) continue
    const href = hrefMatch[1] || hrefMatch[2] || hrefMatch[3]
    if (!href || !isLocalRelativeUrl(href)) continue

    const targetPath = resolveRelativePath(baseDir, href)
    const cssContent = await readResourceText(targetPath, context)
    if (cssContent !== null) {
      const safeCss = cssContent.replace(/<\/style>/gi, '<\\/style>')
      result = result.replace(item.fullMatch, () => `<style>\n/* inlined: ${href} */\n${safeCss}\n</style>`)
    }
  }

  const imgRegex = /<img\b([^>]*)\/?>/gi
  const imgMatches: Array<{ fullMatch: string; attrs: string }> = []
  let iMatch: RegExpExecArray | null
  while ((iMatch = imgRegex.exec(result)) !== null) {
    imgMatches.push({ fullMatch: iMatch[0], attrs: iMatch[1] || '' })
  }

  for (const item of imgMatches) {
    const srcMatch = /\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i.exec(item.attrs)
    if (!srcMatch) continue
    const src = srcMatch[1] || srcMatch[2] || srcMatch[3]
    if (!src || !isLocalRelativeUrl(src)) continue

    const dotIdx = src.lastIndexOf('.')
    const ext = dotIdx !== -1 ? src.slice(dotIdx + 1) : ''
    const targetPath = resolveRelativePath(baseDir, src)

    if (ext.toLowerCase() === 'svg') {
      const svgText = await readResourceText(targetPath, context)
      if (svgText !== null) {
        const dataUri = `data:image/svg+xml;utf8,${encodeURIComponent(svgText)}`
        result = result.replace(item.fullMatch, () => item.fullMatch.replace(srcMatch[0], `src="${dataUri}"`))
      }
    } else {
      const b64 = readResourceBase64(targetPath, context)
      if (b64 !== null) {
        const dataUri = `data:${getMimeTypeFromExt(ext)};base64,${b64}`
        result = result.replace(item.fullMatch, () => item.fullMatch.replace(srcMatch[0], `src="${dataUri}"`))
      }
    }
  }

  return result
}