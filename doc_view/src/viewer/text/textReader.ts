import type { PaginatedDoc } from '../../types.js'
import { t } from '../../i18n/index.js'
import { formatFileSize } from '../core/viewerThemes.js'

const MAX_TEXT_BYTES = 4 * 1024 * 1024
const CHUNK_CHARS = 16384
const PAGE_CHARS = 30000

export const SUPPORTED_ENCODINGS = [
  { label: 'Auto', charset: '' },
  { label: 'UTF-8', charset: 'UTF-8' },
  { label: 'Windows-1251 (Cyrillic)', charset: 'windows-1251' },
  { label: 'CP866 (DOS Cyrillic)', charset: 'IBM866' },
  { label: 'KOI8-R (Russian)', charset: 'KOI8-R' },
  { label: 'ISO-8859-1 (Latin 1)', charset: 'ISO-8859-1' },
  { label: 'UTF-16LE', charset: 'UTF-16LE' },
  { label: 'UTF-16BE', charset: 'UTF-16BE' },
] as const

export function paginate(text: string, size = PAGE_CHARS): string[] {
  if (text.length <= size) return [text]

  const pages: string[] = []
  let i = 0
  const n = text.length

  while (i < n) {
    let j = Math.min(n, i + size)
    if (j < n) {
      const k = text.lastIndexOf('\n', j)
      if (k > i + Math.floor(size / 2)) j = k + 1
    }
    pages.push(text.slice(i, j))
    i = j
  }

  return pages
}

function detectBOM(filePath: string): string | null {
  let fis: JavaObject | null = null
  try {
    const ArrayCls = inu.jvm.cls('java.lang.reflect.Array')
    fis = new (inu.jvm.cls('java.io.FileInputStream'))(new (inu.jvm.cls('java.io.File'))(filePath))
    const header = ArrayCls.callStatic('newInstance', inu.jvm.cls('java.lang.Byte').getStaticField('TYPE'), 4) as JavaObject
    const bytesRead = Number(fis.call('read', header, 0, 4))

    if (bytesRead < 2) return null

    const b0 = Number(ArrayCls.callStatic('getByte', header, 0)) & 0xff
    const b1 = Number(ArrayCls.callStatic('getByte', header, 1)) & 0xff

    if (bytesRead >= 3 && b0 === 0xef && b1 === 0xbb) {
      if ((Number(ArrayCls.callStatic('getByte', header, 2)) & 0xff) === 0xbf) return 'UTF-8'
    }
    if (b0 === 0xff && b1 === 0xfe) return 'UTF-16LE'
    if (b0 === 0xfe && b1 === 0xff) return 'UTF-16BE'
  } catch {
    return null
  } finally {
    try { fis?.call('close') } catch { }
  }
  return null
}

function isStrictUtf8Sample(filePath: string, maxSampleBytes = 65536): boolean {
  let isr: JavaObject | null = null
  try {
    const CharsetCls = inu.jvm.cls('java.nio.charset.Charset')
    const CodingErrorActionCls = inu.jvm.cls('java.nio.charset.CodingErrorAction')
    const decoder = CharsetCls.callStatic('forName', 'UTF-8').call('newDecoder')
    const reportAction = CodingErrorActionCls.getStaticField('REPORT')
    decoder.call('onMalformedInput', reportAction)
    decoder.call('onUnmappableCharacter', reportAction)

    const fis = new (inu.jvm.cls('java.io.FileInputStream'))(new (inu.jvm.cls('java.io.File'))(filePath))
    isr = new (inu.jvm.cls('java.io.InputStreamReader'))(fis, decoder)

    const ArrayCls = inu.jvm.cls('java.lang.reflect.Array')
    const sampleChunk = 8192
    const testBuf = ArrayCls.callStatic('newInstance', inu.jvm.cls('java.lang.Character').getStaticField('TYPE'), sampleChunk)
    let totalSampled = 0

    while (totalSampled < maxSampleBytes) {
      const count = Number(isr.call('read', testBuf, 0, sampleChunk))
      if (count <= 0) break
      totalSampled += count * 2
    }
    return true
  } catch {
    return false
  } finally {
    try { isr?.call('close') } catch { }
  }
}

function yieldTurn(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0))
}

export async function readTextDocumentAsync(
  filePath: string,
  requestedCharset?: string
): Promise<PaginatedDoc> {
  await yieldTurn()

  const file = new (inu.jvm.cls('java.io.File'))(filePath)
  if (Number(file.call('length')) <= 0) {
    return { pages: [''], font: 0, wrap: true, encoding: 'UTF-8' }
  }

  let charset = requestedCharset
  if (!charset) {
    const bom = detectBOM(filePath)
    if (bom) charset = bom
    else if (isStrictUtf8Sample(filePath)) charset = 'UTF-8'
    else charset = 'windows-1251'
  }

  await yieldTurn()

  const fis = new (inu.jvm.cls('java.io.FileInputStream'))(file)
  const isr = new (inu.jvm.cls('java.io.InputStreamReader'))(fis, charset)

  const ArrayCls = inu.jvm.cls('java.lang.reflect.Array')
  const StringCls = inu.jvm.cls('java.lang.String')
  const charBuf = ArrayCls.callStatic('newInstance', inu.jvm.cls('java.lang.Character').getStaticField('TYPE'), CHUNK_CHARS) as JavaObject

  const chunks: string[] = []
  let totalReadChars = 0
  let isTruncated = false
  let loopCount = 0

  try {
    while (true) {
      const count = Number(isr.call('read', charBuf, 0, CHUNK_CHARS))
      if (count <= 0) break

      chunks.push(String(StringCls.callStatic('valueOf', charBuf, 0, count)))
      totalReadChars += count

      if (totalReadChars * 2 >= MAX_TEXT_BYTES) {
        isTruncated = true
        break
      }

      loopCount++
      if (loopCount % 4 === 0) await yieldTurn()
    }
  } finally {
    try { isr.call('close') } catch { }
  }

  await yieldTurn()

  let fullText = chunks.join('').replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\0/g, '')
  if (fullText.charCodeAt(0) === 0xfeff) fullText = fullText.slice(1)

  if (isTruncated) {
    fullText += `\n\n${t('text.fileTruncated', { size: formatFileSize(MAX_TEXT_BYTES) })}`
  }

  return {
    pages: paginate(fullText),
    font: 0,
    wrap: true,
    encoding: charset,
  }
}