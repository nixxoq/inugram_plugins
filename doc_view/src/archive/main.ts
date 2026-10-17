import type { PaginatedDoc } from '../types.js'
import { paginate } from '../viewer/text/textReader.js'
import { formatBytes } from '../utils/tableFormatter.js'
import { isZipFile, readZipCatalog, type ZipArchiveCatalog } from './zip/helper.js'
import { buildArchiveTree, type ArchiveTree } from './tree.js'
import { t } from '../i18n/index.js'

export function loadArchiveCatalog(filePath: string, desiredCharset?: string): ZipArchiveCatalog {
  return readZipCatalog(filePath, desiredCharset)
}

export function loadArchiveTree(filePath: string, desiredCharset?: string): ArchiveTree {
  return buildArchiveTree(readZipCatalog(filePath, desiredCharset))
}

export async function parseArchiveDocument(filePath: string, desiredCharset?: string): Promise<PaginatedDoc> {
  if (!isZipFile(filePath)) {
    return { pages: [t('archive.readStructureFailed')], font: 2, wrap: false }
  }

  let catalog: ZipArchiveCatalog
  try {
    catalog = readZipCatalog(filePath, desiredCharset)
  } catch (err: any) {
    return { pages: [t('archive.readCatalogError', { error: err?.message || err })], font: 2, wrap: false }
  }

  if (catalog.entries.length === 0) {
    return { pages: [t('archive.empty')], font: 2, wrap: false }
  }

  const folders = catalog.entries.filter((e) => e.isDir).length
  const totalUnpackedSize = catalog.entries.reduce((sum, e) => sum + e.size, 0)

  const lines: string[] = [
    t('archive.recordsSummary', {
      entries: catalog.totalEntries,
      folders,
      size: formatBytes(totalUnpackedSize),
    }),
    t('archive.encodingSummary', {
      encoding: catalog.detectedEncoding,
      autoFix: catalog.hasBadChars ? t('archive.autoFixed') : '',
    }),
    '',
  ]

  for (const entry of catalog.entries) {
    const sizeStr = entry.isDir ? t('archive.folderTag') : formatBytes(entry.size)
    const lockStr = entry.isEncrypted ? '[ENC] ' : ''
    lines.push(`${sizeStr.padStart(9, ' ')}  ${entry.mtimeStr.padEnd(16, ' ')}  ${lockStr}${entry.rawPath}`)
  }

  return {
    pages: paginate(lines.join('\n')),
    font: 2,
    wrap: false,
    encoding: catalog.detectedEncoding,
  }
}