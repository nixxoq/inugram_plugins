import {
  CorruptedArchiveError,
  SecurityError,
  SizeLimitError,
  UnsupportedArchiveError,
} from '../errors.js'
import { t } from '../../i18n/index.js'

export interface ZipEntryInfo {
  index: number
  rawPath: string
  name: string
  size: number
  compressedSize: number
  method: number
  crc32: number
  mtime: number
  mtimeStr: string
  isDir: boolean
  isEncrypted: boolean
  isWinZipAes: boolean
  flag: number
  dosTime: number
  localHeaderOffset: number
  dataOffset: number
}

export interface ZipArchiveCatalog {
  entries: ZipEntryInfo[]
  totalEntries: number
  cdOffset: number
  cdSize: number
  fileLength: number
  detectedEncoding: string
  hasBadChars: boolean
}

export function isZipFile(filePath: string): boolean {
  let raf: JavaObject | null = null
  try {
    const FileCls = inu.jvm.cls('java.io.File')
    const RandomAccessFileCls = inu.jvm.cls('java.io.RandomAccessFile')
    const file = new FileCls(filePath)
    if (!Boolean(file.call('exists')) || Number(file.call('length')) < 22) return false

    raf = new RandomAccessFileCls(file, 'r')
    const fileLength = Number(raf.call('length'))
    if (fileLength < 22) return false

    const scanSize = Math.min(fileLength, 65557)
    const scanStart = fileLength - scanSize

    const channel = raf.call('getChannel') as JavaObject
    channel.call('position', scanStart)

    const ByteBufferCls = inu.jvm.cls('java.nio.ByteBuffer')
    const ByteOrderCls = inu.jvm.cls('java.nio.ByteOrder')
    const bb = ByteBufferCls.callStatic('allocate', scanSize) as JavaObject
    bb.call('order', ByteOrderCls.getStaticField('LITTLE_ENDIAN'))
    channel.call('read', bb)

    for (let i = scanSize - 22; i >= 0; i--) {
      if ((Number(bb.call('getInt', i)) >>> 0) === 0x06054b50) return true
    }
    return false
  } catch {
    return false
  } finally {
    try { raf?.call('close') } catch { }
  }
}

function hasCyrillic(str: string): boolean {
  return /[\u0400-\u04FF]/.test(str)
}

function validatePathTraversal(path: string): void {
  const norm = path.replace(/\\/g, '/')
  if (/[\x00-\x1F*?"<>|:]/.test(norm) || /^[a-zA-Z]:/.test(norm)) {
    throw new SecurityError(t('archive.errors.invalidPathChars', { path: norm }))
  }

  const segments = norm.split('/')
  for (let s = 0; s < segments.length; s++) {
    const seg = segments[s]
    if (s === segments.length - 1 && seg === '') continue
    if (seg === '.' || seg === '..' || seg === '') {
      throw new SecurityError(t('archive.errors.invalidPathTraversal', { path: norm }))
    }
  }
}

export function readZipCatalog(filePath: string, desiredCharset?: string): ZipArchiveCatalog {
  const FileCls = inu.jvm.cls('java.io.File')
  const RandomAccessFileCls = inu.jvm.cls('java.io.RandomAccessFile')
  const StringCls = inu.jvm.cls('java.lang.String')
  const CRC32Cls = inu.jvm.cls('java.util.zip.CRC32')
  const ByteBufferCls = inu.jvm.cls('java.nio.ByteBuffer')
  const ByteOrderCls = inu.jvm.cls('java.nio.ByteOrder')
  const littleEndian = ByteOrderCls.getStaticField('LITTLE_ENDIAN')

  const file = new FileCls(filePath)
  if (!Boolean(file.call('exists'))) {
    throw new CorruptedArchiveError(t('archive.errors.archiveNotFound', { path: filePath }))
  }

  const raf = new RandomAccessFileCls(file, 'r')
  try {
    const fileLength = Number(raf.call('length'))
    if (fileLength < 22) {
      throw new CorruptedArchiveError(t('archive.errors.fileTooSmallForZip', { size: fileLength }))
    }

    const channel = raf.call('getChannel') as JavaObject
    const scanSize = Math.min(fileLength, 65557)
    const scanStart = fileLength - scanSize

    channel.call('position', scanStart)
    const scanBb = ByteBufferCls.callStatic('allocate', scanSize) as JavaObject
    scanBb.call('order', littleEndian)
    let scanReadTotal = 0
    while (scanReadTotal < scanSize) {
      const r = Number(channel.call('read', scanBb))
      if (r === -1) break
      scanReadTotal += r
    }

    let eocdPosInBuf = -1
    let eocdOffset = -1

    for (let i = scanSize - 22; i >= 0; i--) {
      if ((Number(scanBb.call('getInt', i)) >>> 0) === 0x06054b50) {
        const commentLen = Number(scanBb.call('getShort', i + 20)) & 0xffff
        if (i + 22 + commentLen <= scanSize) {
          eocdPosInBuf = i
          eocdOffset = scanStart + i
          break
        }
      }
    }

    if (eocdPosInBuf === -1) throw new CorruptedArchiveError(t('archive.errors.eocdNotFound'))

    const totalEntries = Number(scanBb.call('getShort', eocdPosInBuf + 10)) & 0xffff
    const cdSize = Number(scanBb.call('getInt', eocdPosInBuf + 12)) >>> 0
    const cdOffset = Number(scanBb.call('getInt', eocdPosInBuf + 16)) >>> 0

    if (totalEntries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      throw new UnsupportedArchiveError(t('archive.errors.zip64Unsupported'))
    }

    if (cdSize > 10 * 1024 * 1024) {
      throw new SizeLimitError(t('archive.errors.entryExceedsLimit', { name: 'Central Directory', size: Math.round(cdSize / 1024 / 1024), limit: 10 }))
    }

    if (cdOffset + cdSize > eocdOffset || eocdOffset > fileLength) {
      throw new CorruptedArchiveError(`${t('archive.errors.corruptedStructure')}: cdOffset (${cdOffset}) + cdSize (${cdSize}) > eocdOffset (${eocdOffset})`)
    }

    if (totalEntries > 5000) {
      throw new SizeLimitError(t('archive.errors.fileCountExceeded', { count: totalEntries, limit: 5000 }))
    }

    const cdBb = ByteBufferCls.callStatic('allocate', cdSize) as JavaObject
    cdBb.call('order', littleEndian)
    channel.call('position', cdOffset)
    let cdReadTotal = 0
    while (cdReadTotal < cdSize) {
      const r = Number(channel.call('read', cdBb))
      if (r === -1) break
      cdReadTotal += r
    }

    const cdBytes = cdBb.call('array') as JavaObject
    const lfhBb = ByteBufferCls.callStatic('allocate', 30) as JavaObject
    lfhBb.call('order', littleEndian)

    let ptr = 0
    let detectedEncoding = desiredCharset || 'UTF-8'
    let hasBadChars = false
    const rawEntries: Array<{
      index: number
      flag: number
      method: number
      dosTime: number
      dosDate: number
      crc32: number
      compSize: number
      uncompSize: number
      nameOffset: number
      nameLen: number
      extraOffset: number
      extraLen: number
      externalAttr: number
      localHeaderOffset: number
      unicodeName: string | null
      isWinZipAes: boolean
    }> = []

    let stringCtor: JavaConstructor | null = null
    try {
      stringCtor = StringCls.getDeclaredConstructor('([BIILjava/lang/String;)V')
    } catch { }

    const decodeString = (offset: number, len: number, charset: string): string => {
      if (len <= 0) return ''
      if (stringCtor) {
        try {
          return String(stringCtor.newInstance(cdBytes, offset, len, charset).call('toString') || '')
        } catch { }
      }
      try {
        const u8 = new Uint8Array(len)
        for (let i = 0; i < len; i++) u8[i] = Number(cdBb.call('get', offset + i)) & 0xff
        const cs = charset.toLowerCase()
        const label = cs.includes('1251') ? 'windows-1251' : cs.includes('866') ? 'ibm866' : 'utf-8'
        return new (TextDecoder as any)(label).decode(u8)
      } catch {
        return ''
      }
    }

    for (let i = 0; i < totalEntries; i++) {
      if (ptr + 46 > cdSize) throw new CorruptedArchiveError(t('archive.errors.unexpectedCdEnd', { index: i }))

      const sig = Number(cdBb.call('getInt', ptr)) >>> 0
      if (sig !== 0x02014b50) {
        throw new CorruptedArchiveError(t('archive.errors.invalidCdSig', { sig: sig.toString(16), index: i }))
      }

      const flag = Number(cdBb.call('getShort', ptr + 8)) & 0xffff
      const method = Number(cdBb.call('getShort', ptr + 10)) & 0xffff
      const dosTime = Number(cdBb.call('getShort', ptr + 12)) & 0xffff
      const dosDate = Number(cdBb.call('getShort', ptr + 14)) & 0xffff
      const crc32 = Number(cdBb.call('getInt', ptr + 16)) >>> 0
      const compSize = Number(cdBb.call('getInt', ptr + 20)) >>> 0
      const uncompSize = Number(cdBb.call('getInt', ptr + 24)) >>> 0
      const nameLen = Number(cdBb.call('getShort', ptr + 28)) & 0xffff
      const extraLen = Number(cdBb.call('getShort', ptr + 30)) & 0xffff
      const commentLen = Number(cdBb.call('getShort', ptr + 32)) & 0xffff
      const externalAttr = Number(cdBb.call('getInt', ptr + 38)) >>> 0
      const localHeaderOffset = Number(cdBb.call('getInt', ptr + 42)) >>> 0

      if (nameLen > 1024) throw new CorruptedArchiveError(t('archive.errors.nameLenExceeded', { len: nameLen, limit: 1024 }))
      if (extraLen > 4096) throw new CorruptedArchiveError(t('archive.errors.extraLenExceeded', { len: extraLen, limit: 4096 }))
      if (commentLen > 4096) throw new CorruptedArchiveError(t('archive.errors.commentLenExceeded', { len: commentLen, limit: 4096 }))
      if (nameLen + extraLen + commentLen > 65535) throw new CorruptedArchiveError(t('archive.errors.fieldsTotalExceeded'))
      if (ptr + 46 + nameLen + extraLen + commentLen > cdSize) throw new CorruptedArchiveError(t('archive.errors.cdRecordOutOfBounds'))

      if (compSize === 0xffffffff || uncompSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
        throw new UnsupportedArchiveError(t('archive.errors.zip64Unsupported'))
      }

      const nameOffset = ptr + 46
      const extraOffset = ptr + 46 + nameLen

      let unicodeName: string | null = null
      let isWinZipAes = method === 99
      let ePtr = extraOffset
      const extraEnd = extraOffset + extraLen

      while (ePtr + 4 <= extraEnd) {
        const tag = Number(cdBb.call('getShort', ePtr)) & 0xffff
        const tagLen = Number(cdBb.call('getShort', ePtr + 2)) & 0xffff

        if (tag === 0x7075 && tagLen >= 5 && ePtr + 4 + tagLen <= extraEnd) {
          if ((Number(cdBb.call('get', ePtr + 4)) & 0xff) === 1) {
            const expectedNameCrc = Number(cdBb.call('getInt', ePtr + 5)) >>> 0
            const crcCalc = new CRC32Cls()
            crcCalc.call('update', cdBytes, nameOffset, nameLen)
            if ((Number(crcCalc.call('getValue')) >>> 0) === expectedNameCrc) {
              unicodeName = decodeString(ePtr + 9, tagLen - 5, 'UTF-8') || null
            }
          }
        } else if (tag === 0x9901) {
          isWinZipAes = true
        }
        ePtr += 4 + tagLen
      }

      rawEntries.push({
        index: i,
        flag,
        method,
        dosTime,
        dosDate,
        crc32,
        compSize,
        uncompSize,
        nameOffset,
        nameLen,
        extraOffset,
        extraLen,
        externalAttr,
        localHeaderOffset,
        unicodeName,
        isWinZipAes,
      })

      ptr += 46 + nameLen + extraLen + commentLen
    }

    if (!desiredCharset) {
      let foundUtf8Replacement = false
      let foundNonUtf8Bytes = false

      for (const re of rawEntries) {
        if ((re.flag & 0x0800) !== 0) continue
        try {
          const testStr = decodeString(re.nameOffset, re.nameLen, 'UTF-8')
          if (!testStr || testStr.includes('\uFFFD')) {
            foundUtf8Replacement = true
            break
          }
        } catch {
          foundNonUtf8Bytes = true
          break
        }
      }

      if (foundUtf8Replacement || foundNonUtf8Bytes) {
        hasBadChars = true
        let cp866CyrillicCount = 0
        let cp866HasBad = false
        for (const re of rawEntries) {
          if ((re.flag & 0x0800) !== 0) continue
          try {
            const s = decodeString(re.nameOffset, re.nameLen, 'IBM866')
            if (s.includes('\uFFFD')) cp866HasBad = true
            if (hasCyrillic(s)) cp866CyrillicCount++
          } catch {
            cp866HasBad = true
          }
        }

        if (!cp866HasBad && cp866CyrillicCount > 0) {
          detectedEncoding = 'IBM866'
        } else {
          let win1251CyrillicCount = 0
          let win1251HasBad = false
          for (const re of rawEntries) {
            if ((re.flag & 0x0800) !== 0) continue
            try {
              const s = decodeString(re.nameOffset, re.nameLen, 'windows-1251')
              if (s.includes('\uFFFD')) win1251HasBad = true
              if (hasCyrillic(s)) win1251CyrillicCount++
            } catch {
              win1251HasBad = true
            }
          }
          detectedEncoding = !win1251HasBad && win1251CyrillicCount > 0 ? 'windows-1251' : 'IBM866'
        }
      }
    }

    const entries: ZipEntryInfo[] = []

    for (const re of rawEntries) {
      let entryPath = re.unicodeName
        ? re.unicodeName
        : (re.flag & 0x0800) !== 0
          ? decodeString(re.nameOffset, re.nameLen, 'UTF-8')
          : decodeString(re.nameOffset, re.nameLen, detectedEncoding) || decodeString(re.nameOffset, re.nameLen, 'UTF-8')

      validatePathTraversal(entryPath)
      const normalizedPath = entryPath.replace(/\\/g, '/')

      if (re.localHeaderOffset + 30 > fileLength) {
        throw new CorruptedArchiveError(t('archive.errors.lfhOutOfBounds', { offset: re.localHeaderOffset, size: fileLength }))
      }

      lfhBb.call('clear')
      channel.call('position', re.localHeaderOffset)
      let lfhRead = 0
      while (lfhRead < 30) {
        const r = Number(channel.call('read', lfhBb))
        if (r === -1) break
        lfhRead += r
      }

      const lfhSig = Number(lfhBb.call('getInt', 0)) >>> 0
      if (lfhSig !== 0x04034b50) {
        throw new CorruptedArchiveError(t('archive.errors.corruptedLfhSig', { sig: lfhSig.toString(16), index: re.index }))
      }

      const localNameLen = Number(lfhBb.call('getShort', 26)) & 0xffff
      const localExtraLen = Number(lfhBb.call('getShort', 28)) & 0xffff

      if (localNameLen > 1024 || localExtraLen > 4096) {
        throw new CorruptedArchiveError(t('archive.errors.lfhLimitsExceeded', { nameLen: localNameLen, extraLen: localExtraLen }))
      }

      const dataOffset = re.localHeaderOffset + 30 + localNameLen + localExtraLen

      if (dataOffset > fileLength || dataOffset + re.compSize > fileLength || dataOffset + re.compSize > cdOffset) {
        throw new CorruptedArchiveError(t('archive.errors.inconsistentDataOffset', { dataOffset, compSize: re.compSize, cdOffset }))
      }

      const unixMode = (re.externalAttr >>> 16) & 0xffff
      const isUnixDir = unixMode !== 0 && (unixMode & 0o170000) === 0o040000
      const isDosDir = unixMode === 0 && Boolean(re.externalAttr & 0x10)
      const isDir = normalizedPath.endsWith('/') || isUnixDir || isDosDir

      const year = ((re.dosDate >> 9) & 0x7f) + 1980
      const month = Math.max(0, Math.min(11, ((re.dosDate >> 5) & 0x0f) - 1))
      const day = Math.max(1, Math.min(31, re.dosDate & 0x1f))
      const hour = Math.min(23, (re.dosTime >> 11) & 0x1f)
      const min = Math.min(59, (re.dosTime >> 5) & 0x3f)
      const sec = Math.min(59, (re.dosTime & 0x1f) * 2)

      const mtime = new Date(year, month, day, hour, min, sec).getTime()
      const mtimeStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')} ${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}`
      const displayName = normalizedPath.split('/').filter(Boolean).pop() || normalizedPath

      entries.push({
        index: re.index,
        rawPath: normalizedPath,
        name: displayName,
        size: re.uncompSize,
        compressedSize: re.compSize,
        method: re.method,
        crc32: re.crc32,
        mtime,
        mtimeStr,
        isDir,
        isEncrypted: Boolean(re.flag & 1),
        isWinZipAes: re.isWinZipAes,
        flag: re.flag,
        dosTime: re.dosTime,
        localHeaderOffset: re.localHeaderOffset,
        dataOffset,
      })
    }

    return {
      entries,
      totalEntries: entries.length,
      cdOffset,
      cdSize,
      fileLength,
      detectedEncoding,
      hasBadChars,
    }
  } finally {
    try { raf.call('close') } catch { }
  }
}

export function listZipEntries(
  filePath: string,
  maxEntries = 1000,
  charsetCandidate?: string
): { entries: Array<{ name: string; size: number; mtime: string; isDir: boolean; isEncrypted: boolean }>; totalCount: number; hasBadChars: boolean } {
  if (typeof inu !== 'undefined' && inu?.jvm) {
    try {
      const catalog = readZipCatalog(filePath, charsetCandidate)
      const limited = catalog.entries.slice(0, maxEntries).map((e) => ({
        name: e.rawPath,
        size: e.size,
        mtime: e.mtimeStr,
        isDir: e.isDir,
        isEncrypted: e.isEncrypted,
      }))
      return { entries: limited, totalCount: catalog.totalEntries, hasBadChars: catalog.hasBadChars }
    } catch {
      return { entries: [], totalCount: 0, hasBadChars: false }
    }
  }
  return { entries: [], totalCount: 0, hasBadChars: false }
}

export function openZipFile(filePath: string): JavaObject | null {
  if (typeof inu !== 'undefined' && inu?.jvm) {
    try {
      const FileCls = inu.jvm.cls('java.io.File')
      const ZipFileCls = inu.jvm.cls('java.util.zip.ZipFile')
      return new ZipFileCls(new FileCls(filePath))
    } catch {
      return null
    }
  }
  return null
}

export function closeZipFile(zip: JavaObject | null): void {
  try { zip?.call('close') } catch { }
}

export function readZipEntryRawBytes(
  filePath: string,
  entryName: string,
  maxBytes = 10 * 1024 * 1024,
  charset?: string
): JavaObject | null {
  if (typeof inu === 'undefined' || !inu?.jvm) return null

  let raf: JavaObject | null = null
  let inflater: JavaObject | null = null

  try {
    const catalog = readZipCatalog(filePath, charset)
    const norm = entryName.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\//, '')
    const entry = catalog.entries.find((e) => e.rawPath === norm || e.rawPath.toLowerCase() === norm.toLowerCase())

    if (!entry || entry.isDir || entry.isEncrypted || entry.size > maxBytes) return null

    const FileCls = inu.jvm.cls('java.io.File')
    const RandomAccessFileCls = inu.jvm.cls('java.io.RandomAccessFile')
    const ByteBufferCls = inu.jvm.cls('java.nio.ByteBuffer')
    const ArrayCls = inu.jvm.cls('java.lang.reflect.Array')
    const ByteCls = inu.jvm.cls('java.lang.Byte')
    const byteType = ByteCls.getStaticField('TYPE')

    if (entry.size === 0) return ArrayCls.callStatic('newInstance', byteType, 0) as JavaObject

    raf = new RandomAccessFileCls(new FileCls(filePath), 'r')
    const channel = raf.call('getChannel') as JavaObject
    channel.call('position', entry.dataOffset)

    if (entry.method === 0) {
      const bb = ByteBufferCls.callStatic('allocate', entry.size) as JavaObject
      let totalRead = 0
      while (totalRead < entry.size) {
        const r = Number(channel.call('read', bb))
        if (r === -1) break
        totalRead += r
      }
      return bb.call('array') as JavaObject
    }

    if (entry.method === 8) {
      const compBb = ByteBufferCls.callStatic('allocate', entry.compressedSize) as JavaObject
      let totalRead = 0
      while (totalRead < entry.compressedSize) {
        const r = Number(channel.call('read', compBb))
        if (r === -1) break
        totalRead += r
      }
      const compBytes = compBb.call('array') as JavaObject

      inflater = new (inu.jvm.cls('java.util.zip.Inflater'))(true)
      inflater.call('setInput', compBytes, 0, entry.compressedSize)

      const outBytes = ArrayCls.callStatic('newInstance', byteType, entry.size) as JavaObject
      let totalInflated = 0
      while (!Boolean(inflater.call('finished')) && totalInflated < entry.size) {
        const count = Number(inflater.call('inflate', outBytes, totalInflated, entry.size - totalInflated))
        if (count <= 0) break
        totalInflated += count
      }
      return outBytes
    }

    return null
  } catch {
    return null
  } finally {
    try { inflater?.call('end') } catch { }
    try { raf?.call('close') } catch { }
  }
}

export function readZipEntryText(
  filePathOrZip: string | JavaObject,
  entryName: string,
  maxBytes = 2 * 1024 * 1024,
  charset?: string
): string | null {
  if (typeof inu === 'undefined' || !inu?.jvm) return null

  if (typeof filePathOrZip === 'string') {
    try {
      const rawBytes = readZipEntryRawBytes(filePathOrZip, entryName, maxBytes, charset)
      if (rawBytes) {
        const ArrayCls = inu.jvm.cls('java.lang.reflect.Array')
        const StringCls = inu.jvm.cls('java.lang.String')
        const len = Number(ArrayCls.callStatic('getLength', rawBytes))
        if (len === 0) return ''

        try {
          const stringCtor = StringCls.getDeclaredConstructor('([BIILjava/lang/String;)V')
          return String(stringCtor.newInstance(rawBytes, 0, len, charset || 'UTF-8').call('toString') || '')
        } catch { }

        try {
          return String(new StringCls(rawBytes, 0, len, charset || 'UTF-8'))
        } catch { }

        const u8 = new Uint8Array(len)
        for (let i = 0; i < len; i++) u8[i] = Number(ArrayCls.callStatic('getByte', rawBytes, i)) & 0xff
        const cs = (charset || 'utf-8').toLowerCase()
        const label = cs.includes('1251') ? 'windows-1251' : cs.includes('866') ? 'ibm866' : 'utf-8'
        return new (TextDecoder as any)(label).decode(u8)
      }
    } catch { }
  }

  const FileCls = inu.jvm.cls('java.io.File')
  const ZipFileCls = inu.jvm.cls('java.util.zip.ZipFile')
  const InputStreamReaderCls = inu.jvm.cls('java.io.InputStreamReader')
  const ArrayCls = inu.jvm.cls('java.lang.reflect.Array')
  const CharacterCls = inu.jvm.cls('java.lang.Character')
  const StringCls = inu.jvm.cls('java.lang.String')

  let zip: JavaObject | null = null
  let shouldCloseZip = false
  let isr: JavaObject | null = null

  try {
    if (typeof filePathOrZip === 'string') {
      const file = new FileCls(filePathOrZip)
      zip = new ZipFileCls(file)
      shouldCloseZip = true
    } else {
      zip = filePathOrZip
    }

    let entry = zip.call('getEntry', entryName) as JavaObject | null
    if (!entry && entryName.startsWith('/')) entry = zip.call('getEntry', entryName.slice(1)) as JavaObject | null
    if (!entry && !entryName.startsWith('/') && !entryName.startsWith('xl/')) entry = zip.call('getEntry', 'xl/' + entryName) as JavaObject | null

    if (!entry) {
      const norm = entryName.replace(/\\/g, '/').replace(/^\.\//, '')
      const entries = zip.call('entries') as JavaObject
      while (Boolean(entries.call('hasMoreElements'))) {
        const cand = entries.call('nextElement') as JavaObject
        const candName = String(cand.call('getName')).replace(/\\/g, '/').replace(/^\.\//, '')
        if (candName === norm || candName.toLowerCase() === norm.toLowerCase()) {
          entry = cand
          break
        }
      }
    }
    if (!entry) return null

    const size = Number(entry.call('getSize'))
    if (size > maxBytes) {
      throw new Error(t('archive.errors.entryExceedsLimit', { name: entryName, size: Math.round(size / 1024), limit: Math.round(maxBytes / 1024) }))
    }

    isr = new InputStreamReaderCls(zip.call('getInputStream', entry), 'UTF-8')
    const charBuf = ArrayCls.callStatic('newInstance', CharacterCls.getStaticField('TYPE'), 16384) as JavaObject
    const chunks: string[] = []
    let totalChars = 0

    while (true) {
      const count = Number(isr.call('read', charBuf, 0, 16384))
      if (count <= 0) break
      chunks.push(String(StringCls.callStatic('valueOf', charBuf, 0, count)))
      totalChars += count
      if (totalChars * 2 > maxBytes) break
    }

    return chunks.join('')
  } catch {
    return null
  } finally {
    try { isr?.call('close') } catch { }
    if (shouldCloseZip) {
      try { zip?.call('close') } catch { }
    }
  }
}

export function readZipEntryBase64(
  filePath: string,
  entryName: string,
  maxBytes = 10 * 1024 * 1024
): string | null {
  if (typeof inu === 'undefined' || !inu?.jvm) return null
  try {
    const rawBytes = readZipEntryRawBytes(filePath, entryName, maxBytes)
    if (!rawBytes) return null
    const Base64Cls = inu.jvm.cls('android.util.Base64')
    return String(Base64Cls.callStatic('encodeToString', rawBytes, Number(Base64Cls.getStaticField('NO_WRAP'))))
  } catch {
    return null
  }
}