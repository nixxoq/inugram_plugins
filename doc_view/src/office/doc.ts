import type { PaginatedDoc } from '../types.js'
import { paginate } from '../viewer/text/textReader.js'
import { escapeHtml } from '../utils/html.js'
import { t } from '../i18n/index.js'
import type { ThemeColors } from '../spreadsheet/render.js'
import { buildRtfHtml, parseRtfDocument } from './rtf.js'

const CP1251_TABLE: number[] = [
  0x0402, 0x0403, 0x201a, 0x0453, 0x201e, 0x2026, 0x2020, 0x2021,
  0x20ac, 0x2030, 0x0409, 0x2039, 0x040a, 0x040c, 0x040b, 0x040f,
  0x0452, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
  0x0098, 0x2122, 0x0459, 0x203a, 0x045a, 0x045c, 0x045b, 0x045f,
  0x00a0, 0x040e, 0x045e, 0x0408, 0x00a4, 0x0490, 0x00a6, 0x00a7,
  0x0401, 0x00a9, 0x0404, 0x00ab, 0x00ac, 0x00ad, 0x00ae, 0x0407,
  0x00b0, 0x00b1, 0x0406, 0x0456, 0x0491, 0x00b5, 0x00b6, 0x00b7,
  0x0451, 0x2116, 0x0454, 0x00bb, 0x0458, 0x0405, 0x0455, 0x0457,
  0x0410, 0x0411, 0x0412, 0x0413, 0x0414, 0x0415, 0x0416, 0x0417,
  0x0418, 0x0419, 0x041a, 0x041b, 0x041c, 0x041d, 0x041e, 0x041f,
  0x0420, 0x0421, 0x0422, 0x0423, 0x0424, 0x0425, 0x0426, 0x0427,
  0x0428, 0x0429, 0x042a, 0x042b, 0x042c, 0x042d, 0x042e, 0x042f,
  0x0430, 0x0431, 0x0432, 0x0433, 0x0434, 0x0435, 0x0436, 0x0437,
  0x0438, 0x0439, 0x043a, 0x043b, 0x043c, 0x043d, 0x043e, 0x043f,
  0x0440, 0x0441, 0x0442, 0x0443, 0x0444, 0x0445, 0x0446, 0x0447,
  0x0448, 0x0449, 0x044a, 0x044b, 0x044c, 0x044d, 0x044e, 0x044f,
]

function decode8BitChar(b: number): string {
  if (b < 0x80) return String.fromCharCode(b)
  return String.fromCharCode(CP1251_TABLE[b - 0x80] || b)
}

function decodeBase64ToUint8Array(b64: string): Uint8Array {
  if (typeof atob === 'function') {
    const bin = atob(b64.replace(/\s+/g, ''))
    const u8 = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i)
    return u8
  }
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const lookup = new Uint8Array(256)
  for (let i = 0; i < chars.length; i++) lookup[chars.charCodeAt(i)] = i
  const clean = b64.replace(/[^A-Za-z0-9+/]/g, '')
  let len = clean.length * 0.75
  if (clean.endsWith('==')) len -= 2
  else if (clean.endsWith('=')) len -= 1
  const bytes = new Uint8Array(len)
  let p = 0
  for (let i = 0; i < clean.length; i += 4) {
    const enc1 = lookup[clean.charCodeAt(i)]
    const enc2 = lookup[clean.charCodeAt(i + 1)]
    const enc3 = lookup[clean.charCodeAt(i + 2)]
    const enc4 = lookup[clean.charCodeAt(i + 3)]
    bytes[p++] = (enc1 << 2) | (enc2 >> 4)
    if (clean[i + 2] !== '=') bytes[p++] = ((enc2 & 15) << 4) | (enc3 >> 2)
    if (clean[i + 3] !== '=') bytes[p++] = ((enc3 & 3) << 6) | enc4
  }
  return bytes
}

function readAllBytesFromFile(filePath: string): Uint8Array {
  const FileCls = inu.jvm.cls('java.io.File')
  const file = new FileCls(filePath)
  if (Number(file.call('length')) <= 0) return new Uint8Array(0)

  try {
    const FilesCls = inu.jvm.cls('java.nio.file.Files')
    const Base64Cls = inu.jvm.cls('android.util.Base64')
    const bytes = FilesCls.callStatic('readAllBytes', file.call('toPath'))
    const base64Str = String(Base64Cls.callStatic('encodeToString', bytes, Number(Base64Cls.getStaticField('NO_WRAP'))))
    return decodeBase64ToUint8Array(base64Str)
  } catch {
    const fis = new (inu.jvm.cls('java.io.FileInputStream'))(file)
    const baos = new (inu.jvm.cls('java.io.ByteArrayOutputStream'))()
    const ArrayCls = inu.jvm.cls('java.lang.reflect.Array')
    const buf = ArrayCls.callStatic('newInstance', inu.jvm.cls('java.lang.Byte').getStaticField('TYPE'), 16384) as JavaObject

    try {
      while (true) {
        const read = Number(fis.call('read', buf))
        if (read <= 0) break
        baos.call('write', buf, 0, read)
      }
    } finally {
      try { fis.call('close') } catch { }
    }

    const Base64Cls = inu.jvm.cls('android.util.Base64')
    const base64Str = String(Base64Cls.callStatic('encodeToString', baos.call('toByteArray') as JavaObject, Number(Base64Cls.getStaticField('NO_WRAP'))))
    return decodeBase64ToUint8Array(base64Str)
  }
}

interface CFBDirectoryEntry {
  name: string
  type: number
  startSector: number
  streamSize: number
}

interface CFBStorage {
  sectorSize: number
  miniSectorSize: number
  fat: number[]
  miniFat: number[]
  entries: CFBDirectoryEntry[]
  rootData: Uint8Array
  bytes: Uint8Array
}

function parseCFB(bytes: Uint8Array): CFBStorage | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.length < 512) return null

  if (
    bytes[0] !== 0xd0 || bytes[1] !== 0xcf || bytes[2] !== 0x11 || bytes[3] !== 0xe0 ||
    bytes[4] !== 0xa1 || bytes[5] !== 0xb1 || bytes[6] !== 0x1a || bytes[7] !== 0xe1
  ) {
    return null
  }

  const sectorSize = 1 << view.getUint16(30, true)
  const miniSectorSize = 1 << view.getUint16(32, true)
  const numFatSectors = view.getUint32(44, true)
  const dirFirstSector = view.getUint32(48, true)
  const miniFatFirstSector = view.getUint32(60, true)
  const numMiniFatSectors = view.getUint32(64, true)
  const difatFirstSector = view.getUint32(68, true)
  const numDifatSectors = view.getUint32(72, true)

  const fatSectorIndices: number[] = []
  for (let i = 0; i < 109 && fatSectorIndices.length < numFatSectors; i++) {
    const sec = view.getUint32(76 + i * 4, true)
    if (sec !== 0xfffffffe && sec !== 0xffffffff) fatSectorIndices.push(sec)
  }

  let currDifatSec = difatFirstSector
  for (let i = 0; i < numDifatSectors && currDifatSec !== 0xfffffffe && currDifatSec !== 0xffffffff; i++) {
    const offset = (currDifatSec + 1) * sectorSize
    for (let j = 0; j < (sectorSize / 4) - 1 && fatSectorIndices.length < numFatSectors; j++) {
      const sec = view.getUint32(offset + j * 4, true)
      if (sec !== 0xfffffffe && sec !== 0xffffffff) fatSectorIndices.push(sec)
    }
    currDifatSec = view.getUint32(offset + sectorSize - 4, true)
  }

  const fat: number[] = []
  for (const fatSec of fatSectorIndices) {
    const offset = (fatSec + 1) * sectorSize
    for (let j = 0; j < sectorSize / 4; j++) {
      fat.push(view.getUint32(offset + j * 4, true))
    }
  }

  const getSectorChain = (startSector: number): number[] => {
    const chain: number[] = []
    let curr = startSector
    let guard = 0
    while (curr < 0xfffffffe && guard++ < 65536) {
      chain.push(curr)
      curr = fat[curr] !== undefined ? fat[curr] : 0xfffffffe
    }
    return chain
  }

  const getStreamBytes = (startSector: number, size: number): Uint8Array => {
    const chain = getSectorChain(startSector)
    const result = new Uint8Array(size)
    let written = 0
    for (const sec of chain) {
      const offset = (sec + 1) * sectorSize
      const toCopy = Math.min(sectorSize, size - written)
      if (toCopy <= 0) break
      result.set(bytes.subarray(offset, offset + toCopy), written)
      written += toCopy
    }
    return result
  }

  const dirChain = getSectorChain(dirFirstSector)
  const dirBytes = new Uint8Array(dirChain.length * sectorSize)
  for (let i = 0; i < dirChain.length; i++) {
    const offset = (dirChain[i] + 1) * sectorSize
    dirBytes.set(bytes.subarray(offset, offset + sectorSize), i * sectorSize)
  }

  const dirView = new DataView(dirBytes.buffer, dirBytes.byteOffset, dirBytes.byteLength)
  const numEntries = Math.floor(dirBytes.length / 128)
  const entries: CFBDirectoryEntry[] = []

  for (let i = 0; i < numEntries; i++) {
    const offset = i * 128
    const nameLen = dirView.getUint16(offset + 64, true)
    if (nameLen === 0) continue

    let name = ''
    for (let c = 0; c < Math.max(0, (nameLen - 2) / 2); c++) {
      name += String.fromCharCode(dirView.getUint16(offset + c * 2, true))
    }

    entries.push({
      name,
      type: dirView.getUint8(offset + 66),
      startSector: dirView.getUint32(offset + 116, true),
      streamSize: Number(dirView.getBigUint64(offset + 120, true) & 0xffffffffn),
    })
  }

  const rootEntry = entries[0]
  const rootData = rootEntry ? getStreamBytes(rootEntry.startSector, rootEntry.streamSize) : new Uint8Array(0)

  const miniFatChain = getSectorChain(miniFatFirstSector)
  const miniFat: number[] = []
  for (const mSec of miniFatChain) {
    const offset = (mSec + 1) * sectorSize
    for (let j = 0; j < sectorSize / 4; j++) {
      miniFat.push(view.getUint32(offset + j * 4, true))
    }
  }

  return { sectorSize, miniSectorSize, fat, miniFat, entries, rootData, bytes }
}

function getStreamData(cfb: CFBStorage, entry: CFBDirectoryEntry): Uint8Array {
  const { sectorSize, miniSectorSize, fat, miniFat, rootData, bytes } = cfb

  if (entry.streamSize >= 4096) {
    const chain: number[] = []
    let curr = entry.startSector
    let guard = 0
    while (curr < 0xfffffffe && guard++ < 65536) {
      chain.push(curr)
      curr = fat[curr] !== undefined ? fat[curr] : 0xfffffffe
    }
    const result = new Uint8Array(entry.streamSize)
    let written = 0
    for (const sec of chain) {
      const offset = (sec + 1) * sectorSize
      const toCopy = Math.min(sectorSize, entry.streamSize - written)
      if (toCopy <= 0) break
      result.set(bytes.subarray(offset, offset + toCopy), written)
      written += toCopy
    }
    return result
  }

  const chain: number[] = []
  let curr = entry.startSector
  let guard = 0
  while (curr < 0xfffffffe && guard++ < 65536) {
    chain.push(curr)
    curr = miniFat[curr] !== undefined ? miniFat[curr] : 0xfffffffe
  }
  const result = new Uint8Array(entry.streamSize)
  let written = 0
  for (const sec of chain) {
    const offset = sec * miniSectorSize
    const toCopy = Math.min(miniSectorSize, entry.streamSize - written)
    if (toCopy <= 0) break
    result.set(rootData.subarray(offset, offset + toCopy), written)
    written += toCopy
  }
  return result
}

function extractWordDocumentText(cfb: CFBStorage): string {
  const wordDocEntry = cfb.entries.find((e) => e.name.toLowerCase() === 'worddocument')
  if (!wordDocEntry) return ''

  const wordDoc = getStreamData(cfb, wordDocEntry)
  if (wordDoc.length < 512) return ''

  const wordView = new DataView(wordDoc.buffer, wordDoc.byteOffset, wordDoc.byteLength)
  if (wordView.getUint16(0, true) !== 0xa5ec) return ''

  const is1Table = (wordView.getUint16(10, true) & 0x0200) !== 0
  const tableEntry = cfb.entries.find((e) => e.name.toLowerCase() === (is1Table ? '1table' : '0table'))
  if (!tableEntry) return ''

  const tableData = getStreamData(cfb, tableEntry)
  const tableView = new DataView(tableData.buffer, tableData.byteOffset, tableData.byteLength)

  if (wordDoc.length < 426) return ''
  const fcClx = wordView.getUint32(0x01a2, true)
  const lcbClx = wordView.getUint32(0x01a6, true)

  if (fcClx + lcbClx > tableData.length) return ''

  let pos = fcClx
  const end = fcClx + lcbClx
  let pcdOffset = -1
  let pcdLength = 0

  while (pos < end) {
    const clxt = tableView.getUint8(pos)
    if (clxt === 1) {
      pos += 3 + tableView.getUint16(pos + 1, true)
    } else if (clxt === 2) {
      pcdOffset = pos + 5
      pcdLength = tableView.getUint32(pos + 1, true)
      break
    } else {
      break
    }
  }

  if (pcdOffset === -1 || pcdOffset + pcdLength > tableData.length) return ''

  const numPieces = Math.floor((pcdLength - 4) / 12)
  if (numPieces <= 0) return ''

  const cpArray: number[] = []
  for (let i = 0; i <= numPieces; i++) {
    cpArray.push(tableView.getUint32(pcdOffset + i * 4, true))
  }

  const pcdBase = pcdOffset + (numPieces + 1) * 4
  let fullText = ''

  for (let i = 0; i < numPieces; i++) {
    const charCount = cpArray[i + 1] - cpArray[i]
    if (charCount <= 0) continue

    const fc = tableView.getUint32(pcdBase + i * 8 + 2, true)
    const isCompressed = (fc & 0x40000000) !== 0
    const rawOffset = fc & 0x3fffffff

    if (isCompressed) {
      const byteOffset = Math.floor(rawOffset / 2)
      for (let j = 0; j < charCount; j++) {
        const b = wordDoc[byteOffset + j]
        if (b === undefined) break
        fullText += decode8BitChar(b)
      }
    } else {
      for (let j = 0; j < charCount; j++) {
        const offset = rawOffset + j * 2
        if (offset + 1 >= wordDoc.length) break
        fullText += String.fromCharCode(wordView.getUint16(offset, true))
      }
    }
  }

  return cleanWordText(fullText)
}

function cleanWordText(raw: string): string {
  let cleaned = ''
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    const code = ch.charCodeAt(0)
    if (code === 0x0d || code === 0x07 || code === 0x0b) cleaned += '\n'
    else if (code === 0x0c) cleaned += '\n\n'
    else if (code >= 0x20 || code === 0x09 || code === 0x0a) cleaned += ch
  }
  return cleaned.replace(/\n{3,}/g, '\n\n').trim()
}

export async function parseDocDocument(filePath: string): Promise<PaginatedDoc> {
  const bytes = readAllBytesFromFile(filePath)
  if (bytes.length === 0) return { pages: [t('office.emptyDoc')], font: 0, wrap: true }

  if (bytes[0] === 0x7b && bytes[1] === 0x5c && bytes[2] === 0x72 && bytes[3] === 0x74 && bytes[4] === 0x66) {
    return parseRtfDocument(filePath)
  }

  const cfb = parseCFB(bytes)
  if (!cfb) {
    return { pages: paginate(new TextDecoder('utf-8').decode(bytes)), font: 0, wrap: true }
  }

  const text = extractWordDocumentText(cfb)
  return {
    pages: paginate(text || t('office.emptyDoc')),
    font: 0,
    wrap: true,
  }
}

export async function buildDocHtml(filePath: string, theme: ThemeColors): Promise<string> {
  const bytes = readAllBytesFromFile(filePath)
  if (bytes.length === 0) {
    return `<div style="padding:24px;color:${escapeHtml(theme.fg)};">${escapeHtml(t('office.emptyDoc'))}</div>`
  }

  if (bytes[0] === 0x7b && bytes[1] === 0x5c && bytes[2] === 0x72 && bytes[3] === 0x74 && bytes[4] === 0x66) {
    return buildRtfHtml(filePath, theme)
  }

  const cfb = parseCFB(bytes)
  const text = cfb ? extractWordDocumentText(cfb) : new TextDecoder('utf-8').decode(bytes)
  if (!text) {
    return `<div style="padding:24px;color:${escapeHtml(theme.fg)};">${escapeHtml(t('office.emptyDoc'))}</div>`
  }

  const bodyHtml = text
    .split(/\n\n+/)
    .map((p) => `<p>${p.split('\n').map((l) => escapeHtml(l.trim())).filter(Boolean).join('<br>')}</p>`)
    .join('\n')

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=3.0, user-scalable=yes">
<style>
  :root {
    --bg-color: ${escapeHtml(theme.bg)};
    --fg-color: ${escapeHtml(theme.fg)};
  }
  body {
    background-color: var(--bg-color);
    color: var(--fg-color);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 16px;
    line-height: 1.6;
    padding: 16px 20px 48px 20px;
    margin: 0;
    word-break: break-word;
  }
  p { margin: 0 0 14px 0; text-indent: 1.5em; }
</style>
</head>
<body>
${bodyHtml}
</body>
</html>`
}