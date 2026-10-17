import type { ZipEntryInfo } from '../archive/zip/helper.js'
import { compareComicPaths } from '../archive/tree.js'

const COMIC_IMAGE_EXTS = new Set([
  'jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif', 'avif', 'heic', 'heif',
])

const METADATA_NAMES = new Set([
  'comicinfo.xml', '.ds_store', 'thumbs.db', 'desktop.ini',
])

export function isComicImageEntry(entry: ZipEntryInfo): boolean {
  if (entry.isDir) return false
  const lowerPath = entry.rawPath.toLowerCase()
  if (lowerPath.includes('__macosx') || lowerPath.startsWith('.')) return false

  const baseName = lowerPath.split('/').pop() || ''
  if (METADATA_NAMES.has(baseName)) return false

  const dotIdx = baseName.lastIndexOf('.')
  return dotIdx !== -1 && COMIC_IMAGE_EXTS.has(baseName.slice(dotIdx + 1))
}

export function filterAndSortComicEntries(entries: ZipEntryInfo[]): ZipEntryInfo[] {
  return entries.filter(isComicImageEntry).sort((a, b) => compareComicPaths(a.rawPath, b.rawPath))
}