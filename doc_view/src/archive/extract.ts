import {
  CorruptedArchiveError,
  SizeLimitError,
  UnsupportedArchiveError,
  ZipBombError,
  IndeterminateFilePresenceError,
  PublishError,
  CancelledError,
  SessionQuotaExceededError,
  TimeoutError,
  TruncatedEntryError,
  UnsupportedCompressionMethodError,
  PasswordRequiredError,
  InvalidPasswordError,
} from './errors.js'
import type { ZipEntryInfo } from './zip/helper.js'
import { ZipCryptoEngine } from './zip/crypto.js'
import { t } from '../i18n/index.js'

export const MAX_CD_SIZE = 10 * 1024 * 1024
export const MAX_ENTRIES = 5000
export const MAX_SINGLE_FILE_SIZE = 50 * 1024 * 1024
export const MAX_SESSION_CACHE_SIZE = 150 * 1024 * 1024
export const EXTRACTION_TIMEOUT_MS = 10000
export const MAX_EXPANSION_RATIO = 100

export interface CancellationToken {
  isCancelled: boolean
  onCancelled?: (cb: () => void) => () => void
}

export interface ViewerOwnershipLease {
  readonly targetPath: string
  readonly generation: number
  release(): Promise<void>
}

export interface ExtractionResult {
  targetPath: string
  payloadValidity: 'pending' | 'valid' | 'invalid'
  outputStreamState: 'open' | 'closed' | 'close_error'
  resourceCleanupState: 'clean' | 'failed'
  quotaCommitmentState: 'uncommitted' | 'reserved' | 'committed' | 'released' | 'orphan'
  cleanupError: Error | null
  generation?: number
}

export interface CacheEntry {
  targetPath: string
  size: number
  refCount: number
  lastAccessed: number
  generation: number
}

export interface OrphanRecord {
  path: string
  size: number
  firstSeen: number
  retryCount: number
}

export interface ConsumerRecord {
  consumerId: string
  token: CancellationToken
  wantsViewerLease: boolean
  cancelPromise: Promise<never>
  detachConsumer: () => void
  assignedGeneration?: number
}

export interface InFlightExtraction {
  state: 'active' | 'aborting' | 'settled'
  promise: Promise<ExtractionResult>
  consumers: Map<string, ConsumerRecord>
  sharedToken: CancellationToken
  abortShared: () => void
}

export interface LockHandle {
  isHeld: boolean
  acquire(): Promise<void>
  release(): void
}

export class AsyncMutex {
  private queue: Array<() => void> = []
  private locked = false

  async acquire(): Promise<() => void> {
    if (!this.locked) {
      this.locked = true
      let released = false
      return () => {
        if (released) return
        released = true
        this.dispatchNext()
      }
    }

    return new Promise<() => void>((resolve) => {
      this.queue.push(() => {
        let released = false
        resolve(() => {
          if (released) return
          released = true
          this.dispatchNext()
        })
      })
    })
  }

  private dispatchNext(): void {
    const next = this.queue.shift()
    if (next) next()
    else this.locked = false
  }
}

export function createLockHandle(mutex: AsyncMutex): LockHandle {
  let rawRelease: (() => void) | null = null
  const handle: LockHandle = {
    isHeld: false,
    acquire: async () => {
      if (!handle.isHeld) {
        rawRelease = await mutex.acquire()
        handle.isHeld = true
      }
    },
    release: () => {
      if (handle.isHeld) {
        handle.isHeld = false
        const rel = rawRelease
        rawRelease = null
        rel?.()
      }
    },
  }
  return handle
}

export type FilePresence = 'exists' | 'absent' | 'unknown'

export function checkFilePresence(file: JavaObject | null | undefined): FilePresence {
  if (!file) return 'absent'
  try {
    return Boolean(file.call('exists')) ? 'exists' : 'absent'
  } catch (err) {
    console.warn('[DocViewer] file.exists() failed:', err)
    return 'unknown'
  }
}

export function yieldEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

let opCounter = 1
export function generateUniqueOpId(): string {
  return `${Date.now()}_${opCounter++}_${Math.random().toString(36).slice(2, 8)}`
}

export class ArchiveSession {
  readonly archivePath: string
  readonly sessionDirPath: string
  readonly sessionDir: JavaObject

  readonly sessionAccountingMutex = new AsyncMutex()
  sessionUsedBytes = 0
  sessionReservedBytes = 0
  sessionOrphanBytes = 0
  isSessionBlocked = false
  isTearingDown = false
  activeOwnersCount = 0
  nextEntryGeneration = 1

  readonly committedEntries = new Map<string, CacheEntry>()
  readonly activeExtractionPromises = new Map<string, InFlightExtraction>()
  readonly activePartFiles = new Map<string, string>()
  readonly sessionActiveTokens = new Set<CancellationToken>()
  readonly sessionOrphans = new Map<string, OrphanRecord>()

  constructor(archivePath: string, sessionDirPath: string, sessionDir: JavaObject) {
    this.archivePath = archivePath
    this.sessionDirPath = sessionDirPath
    this.sessionDir = sessionDir
  }

  get sessionCommittedBytes(): number {
    return this.sessionUsedBytes + this.sessionReservedBytes + this.sessionOrphanBytes
  }

  createViewerLease(entryUniqueId: string, targetPath: string, generation: number): ViewerOwnershipLease {
    let isReleased = false
    return {
      targetPath,
      generation,
      release: async () => {
        if (isReleased) return
        isReleased = true
        await this.releaseViewerOwnership(entryUniqueId, generation)
      },
    }
  }

  async releaseViewerOwnership(entryUniqueId: string, generation: number): Promise<void> {
    const releaseLock = createLockHandle(this.sessionAccountingMutex)
    await releaseLock.acquire()
    try {
      const cached = this.committedEntries.get(entryUniqueId)
      if (cached && cached.generation === generation && cached.refCount > 0) {
        cached.refCount--
      }
      this.activeOwnersCount--

      if (this.isTearingDown && this.activeOwnersCount === 0) {
        await this.performSessionDirectoryTeardown()
      }
    } finally {
      releaseLock.release()
    }
  }

  async performSessionDirectoryTeardown(): Promise<void> {
    try {
      deleteFileOrDirRecursively(this.sessionDir)
    } catch (err) {
      console.error('[DocViewer] Session dir deletion error:', err)
    }
  }
}

function deleteFileOrDirRecursively(file: JavaObject): boolean {
  try {
    if (Boolean(file.call('isDirectory'))) {
      const children = file.call('listFiles') as JavaObject[] | null
      if (children) {
        for (const child of children) deleteFileOrDirRecursively(child)
      }
    }
    file.call('delete')
    return !Boolean(file.call('exists'))
  } catch {
    return false
  }
}

const activeSessions = new Map<string, ArchiveSession>()

function getSessionParentDir(): string {
  try {
    const act = inu.android.getCurrentActivity()
    if (act) {
      const cacheDir = act.call('getCacheDir') as JavaObject
      return `${String(cacheDir.call('getAbsolutePath'))}/doc_view_archives`
    }
  } catch { }
  return '/data/local/tmp/doc_view_archives'
}

function hashString(str: string): string {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0
  }
  return (hash >>> 0).toString(16)
}

export function getOrCreateArchiveSession(archivePath: string): ArchiveSession {
  let session = activeSessions.get(archivePath)
  if (session && !session.isTearingDown) return session

  const parentDir = getSessionParentDir()
  const safeName = archivePath.split(/[/\\]/).pop()?.replace(/[^a-zA-Z0-9._-]/g, '_') || 'archive'
  const sessionDirPath = `${parentDir}/${hashString(archivePath)}_${safeName}`

  const sessionDir = new (inu.jvm.cls('java.io.File'))(sessionDirPath)
  try { sessionDir.call('mkdirs') } catch { }

  session = new ArchiveSession(archivePath, sessionDirPath, sessionDir)
  activeSessions.set(archivePath, session)
  return session
}

export async function closeArchiveSession(archivePath: string): Promise<void> {
  const session = activeSessions.get(archivePath)
  if (!session) return

  session.isTearingDown = true
  for (const token of session.sessionActiveTokens) {
    token.isCancelled = true
  }

  const lock = createLockHandle(session.sessionAccountingMutex)
  await lock.acquire()
  try {
    if (session.activeOwnersCount === 0) {
      await session.performSessionDirectoryTeardown()
      activeSessions.delete(archivePath)
    }
  } finally {
    lock.release()
  }
}

export async function openArchiveEntryInViewer(
  archivePath: string,
  entry: ZipEntryInfo,
  options: { cancellationToken: CancellationToken; password?: string }
): Promise<{ lease: ViewerOwnershipLease; targetPath: string }> {
  const session = getOrCreateArchiveSession(archivePath)
  const res = await getOrExtractShared(session, `entry_${entry.index}`, entry, {
    cancellationToken: options.cancellationToken,
    wantsViewerLease: true,
    password: options.password,
  })
  return { lease: res.lease!, targetPath: res.targetPath }
}

export async function extractArchiveEntry(
  archivePath: string,
  entry: ZipEntryInfo,
  options: { cancellationToken: CancellationToken; password?: string }
): Promise<ExtractionResult> {
  const session = getOrCreateArchiveSession(archivePath)
  const res = await getOrExtractShared(session, `entry_${entry.index}`, entry, {
    cancellationToken: options.cancellationToken,
    wantsViewerLease: false,
    password: options.password,
  })
  return {
    targetPath: res.targetPath,
    payloadValidity: res.payloadValidity,
    outputStreamState: res.outputStreamState,
    resourceCleanupState: res.resourceCleanupState,
    quotaCommitmentState: res.quotaCommitmentState,
    cleanupError: res.cleanupError,
    generation: res.generation,
  }
}

function attachCancellation(token: CancellationToken): { cancelPromise: Promise<never>; detach: () => void } {
  let unreg: (() => void) | null = null
  let interval: any = null
  let detached = false

  const cancelPromise = new Promise<never>((_, reject) => {
    const fire = () => reject(new CancelledError(t('archive.errors.cancelled')))
    if (token.isCancelled) return fire()

    if (typeof token.onCancelled === 'function') {
      unreg = token.onCancelled(fire)
    } else {
      interval = setInterval(() => {
        if (token.isCancelled) {
          clearInterval(interval)
          interval = null
          fire()
        }
      }, 20)
    }
  })
  cancelPromise.catch(() => { })

  const detach = () => {
    if (detached) return
    detached = true
    unreg?.()
    if (interval) clearInterval(interval)
  }

  return { cancelPromise, detach }
}

async function getOrExtractShared(
  session: ArchiveSession,
  entryUniqueId: string,
  entry: ZipEntryInfo,
  options: { cancellationToken: CancellationToken; wantsViewerLease: boolean; password?: string }
): Promise<ExtractionResult & { lease?: ViewerOwnershipLease }> {
  const { cancellationToken, wantsViewerLease } = options

  while (true) {
    if (cancellationToken.isCancelled) throw new CancelledError(t('archive.errors.cancelled'))

    const consumerId = generateUniqueOpId()
    const { cancelPromise, detach: detachConsumer } = attachCancellation(cancellationToken)

    const consumerRecord: ConsumerRecord = {
      consumerId,
      token: cancellationToken,
      wantsViewerLease,
      cancelPromise,
      detachConsumer,
    }

    const dispatchLock = createLockHandle(session.sessionAccountingMutex)
    let inFlightToAwait: InFlightExtraction | null = null
    let inFlightToWaitSettling: InFlightExtraction | null = null
    let cancelledDuringAcquire = false

    const acquirePromise = dispatchLock.acquire().then(
      () => { if (cancelledDuringAcquire) dispatchLock.release() },
      (err) => { if (!cancelledDuringAcquire) throw err }
    )

    try {
      await Promise.race([
        acquirePromise,
        cancelPromise.then(() => {
          cancelledDuringAcquire = true
          throw new CancelledError(t('archive.errors.cancelled'))
        }),
      ])
    } catch (acquireErr) {
      detachConsumer()
      throw acquireErr
    }

    try {
      if (cancellationToken.isCancelled) throw new CancelledError(t('archive.errors.cancelled'))
      if (session.isTearingDown) throw new CancelledError(t('archive.errors.sessionClosing'))

      const cached = session.committedEntries.get(entryUniqueId)
      if (cached) {
        const targetFile = new (inu.jvm.cls('java.io.File'))(cached.targetPath)
        const presence = checkFilePresence(targetFile)

        if (presence === 'unknown') {
          throw new IndeterminateFilePresenceError(`Disk cache verification failed: ${cached.targetPath}`)
        }
        if (presence === 'exists') {
          if (cancellationToken.isCancelled) throw new CancelledError(t('archive.errors.cancelled'))
          if (wantsViewerLease) {
            cached.refCount++
            session.activeOwnersCount++
          }
          cached.lastAccessed = Date.now()

          const lease = wantsViewerLease
            ? session.createViewerLease(entryUniqueId, cached.targetPath, cached.generation)
            : undefined

          detachConsumer()
          return {
            targetPath: cached.targetPath,
            payloadValidity: 'valid',
            outputStreamState: 'closed',
            resourceCleanupState: 'clean',
            quotaCommitmentState: 'committed',
            cleanupError: null,
            generation: cached.generation,
            lease,
          }
        }
        if (presence === 'absent') {
          session.sessionUsedBytes = Math.max(0, session.sessionUsedBytes - cached.size)
          session.committedEntries.delete(entryUniqueId)
        }
      }

      let inFlight = session.activeExtractionPromises.get(entryUniqueId)
      if (inFlight) {
        if (inFlight.state === 'active') {
          inFlight.consumers.set(consumerId, consumerRecord)
          inFlightToAwait = inFlight
        } else {
          inFlightToWaitSettling = inFlight
        }
      } else {
        const sharedToken: CancellationToken = { isCancelled: false }
        inFlight = {
          state: 'active',
          promise: null as any,
          consumers: new Map([[consumerId, consumerRecord]]),
          sharedToken,
          abortShared: () => { sharedToken.isCancelled = true },
        }

        const extractionPromise = extractArchiveEntryInternal(session, entryUniqueId, entry, inFlight, {
          cancellationToken: sharedToken,
          password: options.password,
        })

        extractionPromise
          .catch(() => { })
          .finally(() => {
            inFlight!.state = 'settled'
            if (session.activeExtractionPromises.get(entryUniqueId) === inFlight) {
              session.activeExtractionPromises.delete(entryUniqueId)
            }
          })

        inFlight.promise = extractionPromise
        session.activeExtractionPromises.set(entryUniqueId, inFlight)
        inFlightToAwait = inFlight
      }
    } catch (err) {
      detachConsumer()
      throw err
    } finally {
      dispatchLock.release()
    }

    if (inFlightToAwait) {
      return await awaitSharedExtraction(session, entryUniqueId, inFlightToAwait, consumerRecord)
    }

    if (inFlightToWaitSettling) {
      try {
        await Promise.race([inFlightToWaitSettling.promise.catch(() => { }), consumerRecord.cancelPromise])
      } catch (err) {
        detachConsumer()
        if (cancellationToken.isCancelled) throw new CancelledError(t('archive.errors.cancelled'))
        throw err
      }
      detachConsumer()
      if (cancellationToken.isCancelled) throw new CancelledError(t('archive.errors.cancelled'))
    }
  }
}

async function awaitSharedExtraction(
  session: ArchiveSession,
  entryUniqueId: string,
  inFlight: InFlightExtraction,
  consumerRecord: ConsumerRecord
): Promise<ExtractionResult & { lease?: ViewerOwnershipLease }> {
  const { consumerId, token: consumerToken, wantsViewerLease, cancelPromise, detachConsumer } = consumerRecord
  let deliveredLease = false

  try {
    const res = await Promise.race([inFlight.promise, cancelPromise])
    if (consumerToken.isCancelled) throw new CancelledError(t('archive.errors.cancelled'))

    let lease: ViewerOwnershipLease | undefined
    if (wantsViewerLease) {
      const generation = consumerRecord.assignedGeneration ?? res.generation
      if (generation === undefined) {
        throw new Error('Missing cache generation for viewer consumer')
      }
      lease = session.createViewerLease(entryUniqueId, res.targetPath, generation)
      deliveredLease = true
    }

    return { ...res, lease }
  } catch (err) {
    if (consumerToken.isCancelled) throw new CancelledError(t('archive.errors.cancelled'))
    throw err
  } finally {
    detachConsumer()
    inFlight.consumers.delete(consumerId)

    if (wantsViewerLease && !deliveredLease && consumerRecord.assignedGeneration !== undefined) {
      const gen = consumerRecord.assignedGeneration
      consumerRecord.assignedGeneration = undefined
      await session.releaseViewerOwnership(entryUniqueId, gen)
    }

    if (inFlight.consumers.size === 0 && inFlight.state === 'active') {
      inFlight.state = 'aborting'
      inFlight.abortShared()
    }
  }
}

async function extractArchiveEntryInternal(
  session: ArchiveSession,
  entryUniqueId: string,
  entry: ZipEntryInfo,
  inFlight: InFlightExtraction,
  options: { cancellationToken: CancellationToken; password?: string }
): Promise<ExtractionResult> {
  const { cancellationToken } = options

  let payloadValidity: 'pending' | 'valid' | 'invalid' = 'pending'
  let outputStreamState: 'open' | 'closed' | 'close_error' = 'open'
  let resourceCleanupState: 'clean' | 'failed' = 'clean'
  let quotaCommitmentState: 'uncommitted' | 'reserved' | 'committed' | 'released' | 'orphan' = 'uncommitted'
  let hasCreatedPartFile = false
  let publishedGeneration: number | undefined

  const operationId = generateUniqueOpId()
  const partPath = `${session.sessionDirPath}/${entry.index}_${operationId}.part`
  const safeName = entry.name.split(/[/\\]/).pop()?.replace(/[^a-zA-Z0-9._-]/g, '_') || 'file'
  const targetPath = `${session.sessionDirPath}/${entry.index}_${safeName}`

  const FileCls = inu.jvm.cls('java.io.File')
  const ByteBufferCls = inu.jvm.cls('java.nio.ByteBuffer')

  let partFile: JavaObject | null = null
  let fos: JavaObject | null = null
  let fis: JavaObject | null = null
  let inflater: JavaObject | null = null
  let crc32: JavaObject | null = null

  let primaryError: Error | null = null
  let cleanupError: Error | null = null
  let totalUncompressed = 0

  session.sessionActiveTokens.add(cancellationToken)

  try {
    const reservationLock = createLockHandle(session.sessionAccountingMutex)
    await reservationLock.acquire()
    try {
      if (session.isTearingDown) throw new CancelledError(t('archive.errors.sessionClosing'))
      if (cancellationToken.isCancelled) throw new CancelledError(t('archive.errors.cancelled'))
      if (session.isSessionBlocked) throw new SessionQuotaExceededError(t('archive.errors.sessionBlocked'))

      if (session.sessionCommittedBytes + entry.size > MAX_SESSION_CACHE_SIZE) {
        await evictUnreferencedFilesLRU(session, entry.size, reservationLock)
      }

      if (session.isTearingDown) throw new CancelledError(t('archive.errors.sessionClosing'))
      if (cancellationToken.isCancelled) throw new CancelledError(t('archive.errors.cancelled'))

      if (session.sessionCommittedBytes + entry.size > MAX_SESSION_CACHE_SIZE) {
        throw new SessionQuotaExceededError(t('archive.errors.quotaExceeded', { size: Math.round(MAX_SESSION_CACHE_SIZE / 1024 / 1024) }))
      }

      session.sessionReservedBytes += entry.size
      quotaCommitmentState = 'reserved'
      session.activeOwnersCount++
    } finally {
      reservationLock.release()
    }

    try {
      session.activePartFiles.set(operationId, partPath)
      partFile = new FileCls(partPath)
      hasCreatedPartFile = true
      fos = new (inu.jvm.cls('java.io.FileOutputStream'))(partFile)
      fis = new (inu.jvm.cls('java.io.FileInputStream'))(new FileCls(session.archivePath))

      let inChannel: JavaObject | null = null
      let outChannel: JavaObject | null = null
      try {
        inChannel = fis.call('getChannel') as JavaObject | null
        if (inChannel) {
          inChannel.call('position', entry.dataOffset)
          if (Number(inChannel.call('position')) !== entry.dataOffset) {
            throw new CorruptedArchiveError(t('archive.errors.seekFailed', { requested: entry.dataOffset, actual: Number(inChannel.call('position')) }))
          }
        }
      } catch (channelErr: any) {
        if (channelErr instanceof CorruptedArchiveError) throw channelErr
      }

      if (!inChannel) {
        let skipped = 0
        while (skipped < entry.dataOffset) {
          const s = Number(fis.call('skip', entry.dataOffset - skipped))
          if (s <= 0) {
            if (Number(fis.call('read')) === -1) {
              throw new CorruptedArchiveError(t('archive.errors.seekFailed', { requested: entry.dataOffset, actual: skipped }))
            }
            skipped++
          } else {
            skipped += s
          }
        }
      }

      outChannel = fos.call('getChannel') as JavaObject

      if (entry.isWinZipAes || entry.method === 99) {
        throw new UnsupportedCompressionMethodError(t('archive.errors.winzipAesUnsupported'))
      }

      let cryptoEngine: ZipCryptoEngine | null = null
      let effCompressedSize = entry.compressedSize

      if (entry.isEncrypted) {
        if (!options.password) throw new PasswordRequiredError(t('archive.errors.passwordRequired'))
        if (entry.compressedSize < 12) throw new CorruptedArchiveError(t('archive.errors.corruptedCompressedSize'))

        const headerBb = ByteBufferCls.callStatic('allocate', 12) as JavaObject
        let hRead = 0
        while (hRead < 12) {
          const r = inChannel ? Number(inChannel.call('read', headerBb)) : Number(fis.call('read'))
          if (r === -1) break
          if (!inChannel) {
            headerBb.call('put', hRead, r & 0xff)
            hRead++
          } else {
            hRead += r
          }
        }
        if (hRead < 12) throw new TruncatedEntryError(t('archive.errors.truncatedZipCryptoHeader'))

        headerBb.call('flip')
        const headerBytes = new Uint8Array(12)
        for (let i = 0; i < 12; i++) headerBytes[i] = Number(headerBb.call('get', i)) & 0xff

        const expectedCheck = (entry.flag & 8) !== 0 ? (entry.dosTime >> 8) & 0xff : (entry.crc32 >>> 24) & 0xff
        const { isValid, engine } = ZipCryptoEngine.verifyHeader(headerBytes, options.password, expectedCheck)
        if (!isValid || !engine) throw new InvalidPasswordError(t('archive.errors.invalidPassword'))

        cryptoEngine = engine
        effCompressedSize = entry.compressedSize - 12
      }

      crc32 = new (inu.jvm.cls('java.util.zip.CRC32'))()
      const inBb = ByteBufferCls.callStatic('allocate', 32768) as JavaObject
      const outBb = ByteBufferCls.callStatic('allocate', 32768) as JavaObject
      const deadline = Date.now() + EXTRACTION_TIMEOUT_MS

      if (entry.method === 0) {
        let remaining = entry.size
        if (effCompressedSize !== entry.size) {
          throw new CorruptedArchiveError(t('archive.errors.sizeMismatch', { expected: entry.size, actual: effCompressedSize }))
        }

        while (remaining > 0) {
          if (Date.now() > deadline) throw new TimeoutError(t('archive.errors.timeout'))
          if (cancellationToken.isCancelled) throw new CancelledError(t('archive.errors.cancelled'))

          inBb.call('clear')
          inBb.call('limit', Math.min(32768, remaining))
          const bytesRead = inChannel ? Number(inChannel.call('read', inBb)) : -1
          if (bytesRead < 0) throw new TruncatedEntryError(t('archive.errors.truncatedStored'))
          if (bytesRead === 0) {
            await yieldEventLoop()
            continue
          }

          if (cryptoEngine) {
            for (let i = 0; i < bytesRead; i++) {
              inBb.call('put', i, cryptoEngine.decryptByte(Number(inBb.call('get', i)) & 0xff))
            }
          }

          if (totalUncompressed + bytesRead > entry.size) throw new SizeLimitError(t('archive.errors.dataSizeExceeded'))
          if (totalUncompressed + bytesRead > MAX_SINGLE_FILE_SIZE) {
            throw new SizeLimitError(t('archive.errors.singleFileSizeExceeded', { limit: MAX_SINGLE_FILE_SIZE }))
          }

          inBb.call('flip')
          outChannel.call('write', inBb)
          inBb.call('rewind')
          crc32.call('update', inBb)
          totalUncompressed += bytesRead
          remaining -= bytesRead
          await yieldEventLoop()
        }
      } else if (entry.method === 8) {
        inflater = new (inu.jvm.cls('java.util.zip.Inflater'))(true)
        let compRemaining = effCompressedSize

        while (compRemaining > 0 || !Boolean(inflater.call('finished'))) {
          if (Date.now() > deadline) throw new TimeoutError(t('archive.errors.timeout'))
          if (cancellationToken.isCancelled) throw new CancelledError(t('archive.errors.cancelled'))

          if (Boolean(inflater.call('needsInput'))) {
            if (compRemaining <= 0) throw new TruncatedEntryError(t('archive.errors.truncatedDeflate'))

            inBb.call('clear')
            inBb.call('limit', Math.min(32768, compRemaining))
            const bytesRead = inChannel ? Number(inChannel.call('read', inBb)) : -1
            if (bytesRead < 0) throw new TruncatedEntryError(t('archive.errors.truncatedDeflate'))
            compRemaining -= bytesRead

            if (cryptoEngine) {
              for (let i = 0; i < bytesRead; i++) {
                inBb.call('put', i, cryptoEngine.decryptByte(Number(inBb.call('get', i)) & 0xff))
              }
            }

            inBb.call('flip')
            inflater.call('setInput', inBb)
          }

          let slice = 0
          while (!Boolean(inflater.call('needsInput')) && !Boolean(inflater.call('finished'))) {
            if (Date.now() > deadline) throw new TimeoutError(t('archive.errors.timeout'))
            if (cancellationToken.isCancelled) throw new CancelledError(t('archive.errors.cancelled'))
            if (Boolean(inflater.call('needsDictionary'))) throw new CorruptedArchiveError(t('archive.errors.corruptedStructure'))

            outBb.call('clear')
            const count = Number(inflater.call('inflate', outBb))
            if (count === 0) {
              if (!Boolean(inflater.call('finished')) && !Boolean(inflater.call('needsInput'))) {
                throw new CorruptedArchiveError(t('archive.errors.corruptedStructure'))
              }
              break
            }

            if (totalUncompressed + count > entry.size) throw new SizeLimitError(t('archive.errors.dataSizeExceeded'))
            if (totalUncompressed + count > MAX_SINGLE_FILE_SIZE) {
              throw new SizeLimitError(t('archive.errors.singleFileSizeExceeded', { limit: MAX_SINGLE_FILE_SIZE }))
            }

            const consumed = effCompressedSize - compRemaining - Number(inflater.call('getRemaining'))
            if (totalUncompressed + count > 5 * 1024 * 1024) {
              if (consumed <= 0) throw new ZipBombError(t('archive.errors.zipBomb'))
              if ((totalUncompressed + count) / consumed > MAX_EXPANSION_RATIO) {
                throw new ZipBombError(t('archive.errors.zipBombRatio', { ratio: MAX_EXPANSION_RATIO }))
              }
            }

            outBb.call('flip')
            outChannel.call('write', outBb)
            outBb.call('rewind')
            crc32.call('update', outBb)
            totalUncompressed += count
            slice += count

            if (slice >= 256 * 1024) break
          }
          await yieldEventLoop()
        }
      } else {
        throw new UnsupportedCompressionMethodError(t('archive.errors.unsupportedCompression', { method: entry.method }))
      }

      if (totalUncompressed !== entry.size) {
        throw new CorruptedArchiveError(t('archive.errors.sizeMismatch', { expected: entry.size, actual: totalUncompressed }))
      }

      const compCrc = Number(crc32.call('getValue')) >>> 0
      if (compCrc !== (entry.crc32 >>> 0)) {
        throw new CorruptedArchiveError(t('archive.errors.crcMismatch', { expected: (entry.crc32 >>> 0).toString(16), computed: compCrc.toString(16) }))
      }

      payloadValidity = 'valid'
      try {
        fos.call('flush')
        fos.call('close')
        outputStreamState = 'closed'
      } catch (closeErr: any) {
        outputStreamState = 'close_error'
        throw closeErr
      }
    } catch (err: any) {
      primaryError = err
      payloadValidity = 'invalid'
    } finally {
      if (outputStreamState !== 'closed' && fos) {
        try {
          fos.call('close')
          outputStreamState = 'closed'
        } catch (closeErr: any) {
          if (!cleanupError) cleanupError = closeErr
          resourceCleanupState = 'failed'
        }
      }
      if (fis) {
        try { fis.call('close') } catch (e: any) { if (!cleanupError) cleanupError = e; resourceCleanupState = 'failed' }
      }
      if (inflater) {
        try { inflater.call('end') } catch (e: any) { if (!cleanupError) cleanupError = e; resourceCleanupState = 'failed' }
      }

      const cleanupLock = createLockHandle(session.sessionAccountingMutex)
      await cleanupLock.acquire()
      try {
        const targetFile = new FileCls(targetPath)
        const hasCommitted = session.committedEntries.has(entryUniqueId)
        const targetPresence = checkFilePresence(targetFile)

        if (payloadValidity === 'valid' && outputStreamState === 'closed' && !primaryError && !cancellationToken.isCancelled) {
          if (hasCommitted && targetPresence === 'exists') {
            try { partFile?.call('delete') } catch { }
            const partPresence = checkFilePresence(partFile)

            if (partPresence === 'absent') {
              session.sessionReservedBytes -= entry.size
              quotaCommitmentState = 'released'
            } else {
              const orphanSize = Number(partFile?.call('length')) || entry.size
              session.sessionReservedBytes -= entry.size
              session.sessionOrphanBytes += orphanSize
              quotaCommitmentState = 'orphan'
              session.isSessionBlocked = true
              resourceCleanupState = 'failed'
            }

            const cached = session.committedEntries.get(entryUniqueId)!
            publishedGeneration = cached.generation

            const viewers = Array.from(inFlight.consumers.values()).filter((c) => c.wantsViewerLease)
            for (const v of viewers) v.assignedGeneration = cached.generation
            if (viewers.length > 0) {
              cached.refCount += viewers.length
              session.activeOwnersCount += viewers.length
              cached.lastAccessed = Date.now()
            }
          } else if (targetPresence === 'unknown') {
            try { partFile?.call('delete') } catch { }
            session.sessionReservedBytes -= entry.size
            session.sessionOrphanBytes += Number(partFile?.call('length')) || entry.size
            quotaCommitmentState = 'orphan'
            session.isSessionBlocked = true
            resourceCleanupState = 'failed'
            primaryError = primaryError || new IndeterminateFilePresenceError(`Disk status unknown: ${targetPath}`)
            payloadValidity = 'invalid'
          } else {
            let canRename = true
            if (hasCommitted && targetPresence === 'absent') {
              session.sessionUsedBytes = Math.max(0, session.sessionUsedBytes - session.committedEntries.get(entryUniqueId)!.size)
              session.committedEntries.delete(entryUniqueId)
            }

            if (!hasCommitted && targetPresence === 'exists') {
              try { targetFile.call('delete') } catch { }
              if (checkFilePresence(targetFile) !== 'absent') {
                canRename = false
                session.sessionOrphanBytes += Number(targetFile.call('length')) || entry.size
                session.isSessionBlocked = true

                try { partFile?.call('delete') } catch { }
                session.sessionReservedBytes -= entry.size
                session.sessionOrphanBytes += Number(partFile?.call('length')) || entry.size
                quotaCommitmentState = 'orphan'
                resourceCleanupState = 'failed'
                primaryError = primaryError || new PublishError(`Failed to delete stale target: ${targetPath}`)
                payloadValidity = 'invalid'
              }
            }

            if (canRename) {
              let renameSuccess = false
              try {
                renameSuccess = Boolean(partFile!.call('renameTo', targetFile)) &&
                  checkFilePresence(targetFile) === 'exists' &&
                  checkFilePresence(partFile) === 'absent'
              } catch (e: any) {
                if (!cleanupError) cleanupError = e
              }

              if (renameSuccess) {
                session.sessionReservedBytes -= entry.size
                session.sessionUsedBytes += totalUncompressed
                quotaCommitmentState = 'committed'
                const gen = session.nextEntryGeneration++
                publishedGeneration = gen

                const viewers = Array.from(inFlight.consumers.values()).filter((c) => c.wantsViewerLease)
                for (const v of viewers) v.assignedGeneration = gen

                session.committedEntries.set(entryUniqueId, {
                  targetPath,
                  size: totalUncompressed,
                  refCount: viewers.length,
                  lastAccessed: Date.now(),
                  generation: gen,
                })
                session.activeOwnersCount += viewers.length
              } else {
                if (!primaryError) primaryError = new PublishError(t('archive.errors.publishFailed', { path: targetPath }))
                payloadValidity = 'invalid'
              }
            }
          }
        }

        if (quotaCommitmentState === 'reserved') {
          if (!hasCreatedPartFile) {
            session.sessionReservedBytes -= entry.size
            quotaCommitmentState = 'released'
          } else {
            try { partFile?.call('delete') } catch { }
            if (checkFilePresence(partFile) === 'absent') {
              session.sessionReservedBytes -= entry.size
              quotaCommitmentState = 'released'
            } else {
              session.sessionReservedBytes -= entry.size
              session.sessionOrphanBytes += Number(partFile?.call('length')) || entry.size
              quotaCommitmentState = 'orphan'
              session.isSessionBlocked = true
              resourceCleanupState = 'failed'
            }
          }
        }

        session.activePartFiles.delete(operationId)
        session.activeOwnersCount--

        if (session.isTearingDown && session.activeOwnersCount === 0) {
          await session.performSessionDirectoryTeardown()
        }
      } finally {
        cleanupLock.release()
      }
    }
  } finally {
    session.sessionActiveTokens.delete(cancellationToken)
  }

  const effectiveTargetPath = session.committedEntries.get(entryUniqueId)?.targetPath || targetPath

  if (primaryError) throw primaryError
  if (cancellationToken.isCancelled) throw new CancelledError(t('archive.errors.cancelled'))

  return {
    targetPath: effectiveTargetPath,
    payloadValidity: 'valid',
    outputStreamState,
    resourceCleanupState,
    quotaCommitmentState,
    cleanupError,
    generation: publishedGeneration,
  }
}

async function evictUnreferencedFilesLRU(session: ArchiveSession, neededBytes: number, lock: LockHandle): Promise<void> {
  const FileCls = inu.jvm.cls('java.io.File')
  const candidates = Array.from(session.committedEntries.entries())
    .filter(([_, entry]) => entry.refCount === 0)
    .sort((a, b) => a[1].lastAccessed - b[1].lastAccessed)

  try {
    for (const [id, candidate] of candidates) {
      if (session.sessionCommittedBytes + neededBytes <= MAX_SESSION_CACHE_SIZE) break

      lock.release()
      await yieldEventLoop()
      await lock.acquire()

      if (session.isTearingDown || session.sessionCommittedBytes + neededBytes <= MAX_SESSION_CACHE_SIZE) break

      const current = session.committedEntries.get(id)
      if (!current || current.refCount > 0) continue

      const file = new FileCls(candidate.targetPath)
      try { file.call('delete') } catch { }

      if (checkFilePresence(file) === 'absent') {
        session.committedEntries.delete(id)
        session.sessionUsedBytes = Math.max(0, session.sessionUsedBytes - candidate.size)
      }
    }
  } finally {
    if (!lock.isHeld) await lock.acquire()
  }
}

export async function reconcileSessionAccounting(archivePath: string): Promise<void> {
  const session = activeSessions.get(archivePath)
  if (!session) return

  const lock = createLockHandle(session.sessionAccountingMutex)
  await lock.acquire()
  try {
    await reconcileSessionAccountingLocked(session, lock)
  } finally {
    lock.release()
  }
}

export async function reconcileSessionAccountingLocked(session: ArchiveSession, lock: LockHandle): Promise<void> {
  let files: JavaObject[] | null = null
  try {
    files = session.sessionDir.call('listFiles') as JavaObject[] | null
  } catch (err) {
    session.isSessionBlocked = true
    return
  }
  if (!files) {
    session.isSessionBlocked = true
    return
  }

  const seenDiskPaths = new Set<string>()
  let hadMetadataError = false
  const BATCH_SIZE = 16

  try {
    for (let i = 0; i < files.length; i++) {
      if (i > 0 && i % BATCH_SIZE === 0) {
        lock.release()
        await yieldEventLoop()
        await lock.acquire()
        if (session.isTearingDown) throw new CancelledError(t('archive.errors.sessionClosing'))
      }

      const file = files[i]
      let path = ''
      try {
        path = String(file.call('getAbsolutePath'))
      } catch {
        session.isSessionBlocked = true
        return
      }

      let size = 0
      let hadLengthError = false
      try {
        const raw = file.call('length')
        if (typeof raw === 'number' && raw >= 0) size = raw
        else hadLengthError = true
      } catch {
        hadLengthError = true
      }

      if (hadLengthError) {
        size = 1024 * 1024
        hadMetadataError = true
      }

      seenDiskPaths.add(path)
      if (session.committedEntries.has(path) || (path.endsWith('.part') && Array.from(session.activePartFiles.values()).includes(path))) {
        continue
      }

      try { file.call('delete') } catch { }

      if (checkFilePresence(file) === 'absent') {
        session.sessionOrphans.delete(path)
      } else {
        const existing = session.sessionOrphans.get(path)
        if (existing) {
          existing.retryCount++
          if (size > 0) existing.size = size
        } else {
          session.sessionOrphans.set(path, { path, size, firstSeen: Date.now(), retryCount: 1 })
        }
      }
    }

    const FileCls = inu.jvm.cls('java.io.File')
    for (const orphanPath of session.sessionOrphans.keys()) {
      if (!seenDiskPaths.has(orphanPath)) {
        if (checkFilePresence(new FileCls(orphanPath)) === 'absent') {
          session.sessionOrphans.delete(orphanPath)
        }
      }
    }

    let totalOrphanBytes = 0
    for (const orphan of session.sessionOrphans.values()) totalOrphanBytes += orphan.size
    session.sessionOrphanBytes = totalOrphanBytes
    session.isSessionBlocked = session.sessionOrphans.size > 0 || hadMetadataError
  } finally {
    if (!lock.isHeld) await lock.acquire()
  }
}