import type { DocumentFormat, FormatCategory, ViewerKind } from './types.js'

const EXT_TO_FORMAT: Record<string, DocumentFormat> = {
  pdf: 'pdf',
  jpg: 'image', jpeg: 'image', jpe: 'image', png: 'image', webp: 'image', bmp: 'image',
  gif: 'image', heic: 'image', heif: 'image', avif: 'image', ico: 'image', dib: 'image',
  dng: 'image', cr2: 'image', nef: 'image', arw: 'image', rw2: 'image', orf: 'image',
  html: 'web', htm: 'web', xhtml: 'web', svg: 'web', md: 'web', markdown: 'web', mdown: 'web',
  csv: 'csv', tsv: 'csv', tab: 'csv',
  json: 'json', geojson: 'json', ipynb: 'ipynb',
  doc: 'doc', dot: 'doc', docx: 'docx', docm: 'docx', dotx: 'docx', dotm: 'docx',
  xlsx: 'xlsx', xlsm: 'xlsx', xltx: 'xlsx', xltm: 'xlsx',
  pptx: 'pptx', pptm: 'pptx', ppsx: 'pptx', potx: 'pptx',
  odt: 'odf', ott: 'odf', ods: 'odf', ots: 'odf', odp: 'odf', otp: 'odf',
  rtf: 'rtf', eml: 'eml', epub: 'epub', fb2: 'fb2',
  zip: 'archive', jar: 'archive', aar: 'archive', tar: 'archive', tgz: 'archive', tbz2: 'archive',
  cbz: 'comic', cbr: 'comic',
}

const TEXT_EXTS = new Set([
  'txt', 'text', 'log', 'jsonl', 'ndjson', 'xml', 'plist', 'yaml', 'yml', 'toml',
  'ini', 'cfg', 'conf', 'env', 'properties', 'gradle', 'cmake', 'srt', 'vtt', 'ass',
  'ssa', 'lrc', 'tex', 'bib', 'rst', 'adoc', 'org', 'nfo', 'diff', 'patch', 'vcf',
  'ics', 'gpx', 'kml', 'tcx', 'opml', 'rss', 'atom', 'xsd', 'xsl', 'xslt', 'wsdl',
  'plugin', 'py', 'pyw', 'pyi', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'java',
  'kt', 'kts', 'scala', 'groovy', 'c', 'h', 'cpp', 'cc', 'cxx', 'hpp', 'hh',
  'cs', 'go', 'rs', 'swift', 'm', 'mm', 'php', 'rb', 'pl', 'lua', 'r', 'dart',
  'sh', 'bash', 'zsh', 'fish', 'bat', 'cmd', 'ps1', 'psm1', 'vbs', 'sql', 'css',
  'scss', 'sass', 'less', 'vue', 'svelte', 'gql', 'graphql', 'proto', 'tf', 'hcl',
  'asm', 's', 'v', 'sv', 'vhd', 'vhdl', 'hs', 'ml', 'clj', 'ex', 'exs', 'erl',
  'jl', 'nim', 'zig', 'dockerfile', 'makefile', 'mk', 'ninja', 'gitignore',
  'gitattributes', 'editorconfig', 'lock', 'sum', 'mod', 'pro', 'pri', 'qml',
  'smali', 'csproj', 'sln', 'vcxproj', 'xaml', 'aidl', 'pem', 'crt', 'csr', 'pub',
  'asc', 'reg', 'inf', 'desktop', 'service', 'ahk', 'au3',
])

const FORMAT_TO_CATEGORY: Record<DocumentFormat, FormatCategory> = {
  pdf: 'pdf', image: 'image', web: 'web', csv: 'text', json: 'text', ipynb: 'text',
  doc: 'docs', docx: 'docs', xlsx: 'docs', pptx: 'docs', odf: 'docs', rtf: 'docs',
  eml: 'docs', epub: 'books', fb2: 'books', comic: 'books', archive: 'archive', text: 'text',
}

const FORMAT_TO_KIND: Record<DocumentFormat, ViewerKind> = {
  pdf: 'pdf', image: 'image', comic: 'image', web: 'web', csv: 'web', json: 'text',
  ipynb: 'text', doc: 'web', docx: 'web', xlsx: 'web', pptx: 'text', odf: 'web',
  rtf: 'web', eml: 'text', epub: 'text', fb2: 'text', archive: 'text', text: 'text',
}

export function sniffHeaderMagic(filePath: string): {
  isZip: boolean
  isDoc: boolean
  isRtf: boolean
  isXmlOrText: boolean
} {
  try {
    const file = new (inu.jvm.cls('java.io.File'))(filePath)
    if (!Boolean(file.call('exists'))) {
      return { isZip: false, isDoc: false, isRtf: false, isXmlOrText: false }
    }

    const raf = new (inu.jvm.cls('java.io.RandomAccessFile'))(file, 'r')
    const bytes: number[] = []
    try {
      const len = Math.min(Number(raf.call('length')), 512)
      for (let i = 0; i < len; i++) {
        const b = Number(raf.call('read'))
        if (b === -1) break
        bytes.push(b)
      }
    } finally {
      try { raf.call('close') } catch { }
    }

    if (bytes.length === 0) {
      return { isZip: false, isDoc: false, isRtf: false, isXmlOrText: false }
    }

    const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b
    const isDoc = bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0
    const isRtf = bytes[0] === 0x7b && bytes[1] === 0x5c && bytes[2] === 0x72 && bytes[3] === 0x74 && bytes[4] === 0x66

    let isXmlOrText = false
    let str = ''
    for (let i = 0; i < Math.min(bytes.length, 64); i++) {
      str += String.fromCharCode(bytes[i])
    }
    const trimmed = str.trimStart()

    if (trimmed.startsWith('<?xml') || trimmed.startsWith('<') || trimmed.startsWith('{') || trimmed.startsWith('[')) {
      isXmlOrText = true
    } else {
      let printable = 0
      for (const b of bytes.slice(0, 64)) {
        if ((b >= 0x20 && b <= 0x7e) || b === 0x09 || b === 0x0a || b === 0x0d || b >= 0xc0) {
          printable++
        }
      }
      if (printable >= Math.min(bytes.length, 64) * 0.85) {
        isXmlOrText = true
      }
    }

    return { isZip, isDoc, isRtf, isXmlOrText }
  } catch (err) {
    return { isZip: false, isDoc: false, isRtf: false, isXmlOrText: false }
  }
}

export function detectFormat(fileName: string, mimeType?: string | null): DocumentFormat | null {
  const lowerName = (fileName || '').toLowerCase().trim()
  const lowerMime = (mimeType || '').toLowerCase().trim()

  if (lowerName.endsWith('.tar.gz') || lowerName.endsWith('.tar.bz2') || lowerName.endsWith('.tar.xz')) {
    return 'archive'
  }

  const dotIndex = lowerName.lastIndexOf('.')
  const ext = dotIndex !== -1 ? lowerName.slice(dotIndex + 1) : ''

  if (ext && EXT_TO_FORMAT[ext]) return EXT_TO_FORMAT[ext]
  if (ext && TEXT_EXTS.has(ext)) return 'text'

  if (lowerMime) {
    if (lowerMime === 'application/pdf') return 'pdf'
    if (lowerMime.startsWith('image/')) return 'image'
    if (lowerMime === 'text/html' || lowerMime === 'image/svg+xml' || lowerMime === 'text/markdown') return 'web'
    if (lowerMime === 'text/csv' || lowerMime === 'text/tab-separated-values') return 'csv'
    if (lowerMime === 'application/json') return 'json'
    if (lowerMime === 'application/rtf' || lowerMime === 'text/rtf') return 'rtf'
    if (lowerMime === 'application/epub+zip') return 'epub'
    if (lowerMime === 'message/rfc822') return 'eml'
    if (
      lowerMime === 'application/vnd.comicbook+zip' ||
      lowerMime === 'application/x-cbz' ||
      lowerMime === 'application/x-cbr' ||
      lowerMime === 'application/vnd.comicbook-rar'
    ) return 'comic'
    if (lowerMime === 'application/zip' || lowerMime === 'application/x-tar') return 'archive'
    if (lowerMime.startsWith('text/')) return 'text'
  }

  return null
}

export function getCategoryForFormat(format: DocumentFormat): FormatCategory {
  return FORMAT_TO_CATEGORY[format]
}

export function getKindForFormat(format: DocumentFormat): ViewerKind {
  return FORMAT_TO_KIND[format]
}