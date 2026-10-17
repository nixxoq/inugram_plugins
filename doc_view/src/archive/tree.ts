import type { ZipArchiveCatalog, ZipEntryInfo } from './zip/helper.js'
import { t } from '../i18n/index.js'

export interface ArchiveFileItem {
  entry: ZipEntryInfo
  basename: string
  extension: string
}

export interface ArchiveFolderNode {
  path: string
  name: string
  parentPath: string | null
  folders: Map<string, ArchiveFolderNode>
  files: ArchiveFileItem[]
  totalSubFilesCount: number
  totalSubSize: number
}

export interface ArchiveTree {
  root: ArchiveFolderNode
  catalog: ZipArchiveCatalog
  detectedEncoding: string
  totalFoldersCount: number
  totalFilesCount: number
  totalUncompressedSize: number
}

export function naturalCompare(a: string, b: string): number {
  const ax: (string | number)[] = []
  const bx: (string | number)[] = []

  a.replace(/(\d+)|(\D+)/g, (_, $1, $2) => {
    ax.push($1 ? parseInt($1, 10) : $2.toLowerCase())
    return ''
  })
  b.replace(/(\d+)|(\D+)/g, (_, $1, $2) => {
    bx.push($1 ? parseInt($1, 10) : $2.toLowerCase())
    return ''
  })

  while (ax.length && bx.length) {
    const an = ax.shift()!
    const bn = bx.shift()!
    if (an !== bn) {
      return (typeof an === 'number' && typeof bn === 'number')
        ? an - bn
        : String(an) < String(bn) ? -1 : 1
    }
  }

  return ax.length ? 1 : bx.length ? -1 : a < b ? -1 : a > b ? 1 : 0
}

export function compareComicPaths(pathA: string, pathB: string): number {
  const partsA = pathA.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').split('/')
  const partsB = pathB.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').split('/')
  const minLen = Math.min(partsA.length, partsB.length)

  for (let i = 0; i < minLen; i++) {
    const cmp = naturalCompare(partsA[i], partsB[i])
    if (cmp !== 0) return cmp
  }

  return partsA.length !== partsB.length ? partsA.length - partsB.length : pathA < pathB ? -1 : pathA > pathB ? 1 : 0
}

export function buildArchiveTree(catalog: ZipArchiveCatalog): ArchiveTree {
  const root: ArchiveFolderNode = {
    path: '',
    name: t('archive.root'),
    parentPath: null,
    folders: new Map(),
    files: [],
    totalSubFilesCount: 0,
    totalSubSize: 0,
  }

  let totalFoldersCount = 0
  let totalFilesCount = 0
  let totalUncompressedSize = 0

  function getOrCreateFolder(parent: ArchiveFolderNode, folderName: string, fullPath: string): ArchiveFolderNode {
    let folder = parent.folders.get(folderName)
    if (!folder) {
      folder = {
        path: fullPath,
        name: folderName,
        parentPath: parent.path,
        folders: new Map(),
        files: [],
        totalSubFilesCount: 0,
        totalSubSize: 0,
      }
      parent.folders.set(folderName, folder)
      totalFoldersCount++
    }
    return folder
  }

  for (const entry of catalog.entries) {
    const normalized = entry.rawPath.replace(/\\/g, '/').replace(/^\/+/, '')
    if (!normalized) continue

    const parts = normalized.split('/').filter(Boolean)
    if (parts.length === 0) continue

    let current = root
    let currentPath = ''

    if (entry.isDir) {
      for (const part of parts) {
        currentPath += part + '/'
        current = getOrCreateFolder(current, part, currentPath)
      }
    } else {
      for (let i = 0; i < parts.length - 1; i++) {
        currentPath += parts[i] + '/'
        current = getOrCreateFolder(current, parts[i], currentPath)
      }

      const filename = parts[parts.length - 1]
      const dotIdx = filename.lastIndexOf('.')
      current.files.push({
        entry,
        basename: filename,
        extension: dotIdx !== -1 ? filename.slice(dotIdx + 1).toLowerCase() : '',
      })

      totalFilesCount++
      totalUncompressedSize += entry.size
    }
  }

  function aggregateAndSort(node: ArchiveFolderNode): void {
    let count = node.files.length
    let size = node.files.reduce((acc, f) => acc + f.entry.size, 0)

    for (const sub of node.folders.values()) {
      aggregateAndSort(sub)
      count += sub.totalSubFilesCount
      size += sub.totalSubSize
    }

    node.totalSubFilesCount = count
    node.totalSubSize = size
    node.files.sort((a, b) => naturalCompare(a.basename, b.basename))
  }

  aggregateAndSort(root)

  return {
    root,
    catalog,
    detectedEncoding: catalog.detectedEncoding,
    totalFoldersCount,
    totalFilesCount,
    totalUncompressedSize,
  }
}

export function getNodeByPath(tree: ArchiveTree, folderPath: string): ArchiveFolderNode | null {
  const norm = folderPath.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!norm) return tree.root

  let current: ArchiveFolderNode = tree.root
  for (const part of norm.split('/').filter(Boolean)) {
    const next = current.folders.get(part)
    if (!next) return null
    current = next
  }
  return current
}

export function getParentFolderPath(folderPath: string): string {
  const norm = folderPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  const lastSlash = norm.lastIndexOf('/')
  return lastSlash === -1 ? '' : norm.slice(0, lastSlash + 1)
}

export function getBreadcrumbs(archiveName: string, folderPath: string): Array<{ name: string; path: string }> {
  const crumbs = [{ name: archiveName, path: '' }]
  const norm = folderPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  if (!norm) return crumbs

  let accumulated = ''
  for (const part of norm.split('/').filter(Boolean)) {
    accumulated += part + '/'
    crumbs.push({ name: part, path: accumulated })
  }
  return crumbs
}