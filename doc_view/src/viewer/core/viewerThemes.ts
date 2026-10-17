import type { ViewerTheme } from '../../types.js'
import { getLanguage, t } from '../../i18n/index.js'

export function toColorInt(c: number): number {
  return c | 0
}

export function formatFileSize(bytes: number): string {
  const isRu = getLanguage() === 'ru'
  if (bytes <= 0) return isRu ? '0 Б' : '0 B'
  const units = isRu ? ['Б', 'КБ', 'МБ', 'ГБ'] : ['B', 'KB', 'MB', 'GB']
  let i = 0
  let v = bytes
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return i === 0 ? `${v} ${units[0]}` : `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`
}

export function isMainThread(): boolean {
  try {
    const LooperCls = inu.jvm.cls('android.os.Looper')
    const myLooper = LooperCls.callStatic('myLooper') as JavaObject | null
    if (!myLooper) return false
    const mainLooper = LooperCls.callStatic('getMainLooper') as JavaObject
    return Boolean(myLooper.call('equals', mainLooper))
  } catch {
    return false
  }
}

export function getMimeTypeFromExtension(fileName: string): string {
  try {
    const dotIdx = fileName.lastIndexOf('.')
    if (dotIdx === -1) return 'application/octet-stream'
    const ext = fileName.slice(dotIdx + 1).toLowerCase()
    const MimeTypeMapCls = inu.jvm.cls('android.webkit.MimeTypeMap')
    const singleton = MimeTypeMapCls.callStatic('getSingleton') as JavaObject
    const mime = singleton.call('getMimeTypeFromExtension', ext)
    if (mime) return String(mime)
  } catch { }
  return 'application/octet-stream'
}

export const THEMES: ViewerTheme[] = [
  {
    get name() { return t('themes.dark') },
    bg: toColorInt(0xff09090d),
    fg: toColorInt(0xffe0e0e0),
    sub: toColorInt(0x88e0e0e0),
    bar: toColorInt(0xcc18181f),
    btn: toColorInt(0x33ffffff),
    pill: toColorInt(0xcc18181f),
    cssBg: '#09090d',
    cssFg: '#e0e0e0',
    cssAlt: '#181820',
  },
  {
    get name() { return t('themes.light') },
    bg: toColorInt(0xfffafaf7),
    fg: toColorInt(0xff1a1a1a),
    sub: toColorInt(0x881a1a1a),
    bar: toColorInt(0xccecece8),
    btn: toColorInt(0x1a000000),
    pill: toColorInt(0xccecece8),
    cssBg: '#fafaf7',
    cssFg: '#1a1a1a',
    cssAlt: '#eeeeee',
  },
  {
    get name() { return t('themes.sepia') },
    bg: toColorInt(0xfff4ecd8),
    fg: toColorInt(0xff3d3222),
    sub: toColorInt(0x883d3222),
    bar: toColorInt(0xcce4dac0),
    btn: toColorInt(0x1a000000),
    pill: toColorInt(0xcce4dac0),
    cssBg: '#f4ecd8',
    cssFg: '#3d3222',
    cssAlt: '#ebdcb9',
  },
]

export function getFontNames(): string[] {
  return [t('fonts.default'), t('fonts.serif'), t('fonts.mono')]
}

export const FONT_NAMES: string[] = new Proxy([] as string[], {
  get(_, prop) {
    const names = getFontNames()
    if (prop === 'length') return names.length
    if (typeof prop === 'string' && !isNaN(Number(prop))) {
      return names[Number(prop)]
    }
    return (names as any)[prop]
  },
})

export const LABELS: Record<string, string> = new Proxy({} as Record<string, string>, {
  get(_, prop) {
    if (typeof prop === 'string') return getFormatLabel(prop)
    return undefined
  },
})

export const WEB_LABELS: Record<string, string> = new Proxy({} as Record<string, string>, {
  get(_, prop) {
    if (typeof prop === 'string') return getWebLabel(prop)
    return undefined
  },
})

export const ARCHIVE_LABELS: Record<string, string> = new Proxy({} as Record<string, string>, {
  get(_, prop) {
    if (typeof prop === 'string') return getArchiveLabel(prop)
    return undefined
  },
})

export function getFormatLabel(format: string): string {
  const map: Record<string, string> = {
    pdf: 'PDF',
    image: t('formats.image'),
    text: t('formats.text'),
    csv: 'CSV',
    json: 'JSON',
    ipynb: 'Jupyter',
    docx: 'DOCX',
    xlsx: 'Excel',
    pptx: 'PowerPoint',
    odf: 'OpenDocument',
    rtf: 'RTF',
    eml: t('formats.eml'),
    epub: 'EPUB',
    fb2: 'FB2',
    archive: t('formats.archive'),
    comic: t('formats.comic'),
    web: 'HTML',
  }
  return map[format] || format.toUpperCase()
}

export function getWebLabel(ext: string): string {
  const map: Record<string, string> = {
    md: 'Markdown',
    markdown: 'Markdown',
    mdown: 'Markdown',
    svg: 'SVG',
    html: 'HTML',
    htm: 'HTML',
    xhtml: 'XHTML',
    docx: t('formats.wordDocument'),
    docm: t('formats.wordDocument'),
    dotx: t('formats.wordTemplate'),
    dotm: t('formats.wordTemplate'),
    odt: t('formats.odtDocument'),
    ott: t('formats.odtTemplate'),
    ods: t('formats.odsDocument'),
    odp: t('formats.odpPresentation'),
    rtf: t('formats.rtfText'),
  }
  return map[ext] || 'HTML'
}

export function getArchiveLabel(ext: string): string {
  const map: Record<string, string> = {
    cbz: t('formats.comic'),
    cbr: t('formats.comic'),
    jar: 'JAR',
    aar: 'AAR',
    tar: 'TAR',
    tgz: 'TAR.GZ',
    tbz2: 'TAR.BZ2',
    txz: 'TAR.XZ',
    zip: 'ZIP',
  }
  return map[ext] || t('archive.title')
}