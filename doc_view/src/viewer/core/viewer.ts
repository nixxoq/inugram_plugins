import type { DocumentFormat, PaginatedDoc, ActiveContentReport, JsDecision } from '../../types.js'
import { settings } from '../../settings.js'
import { loadImageBitmapAsync, type DecodedImage } from '../image/imageLoader.js'
import { openPdfDocument, type PdfDocument } from '../pdf/pdfRenderer.js'
import { buildDocumentAsync, buildHtmlDocumentAsync } from '../../parsers/dispatcher.js'
import { inspectActiveContent } from '../../security/activeContentDetector.js'
import { sanitizeHtml } from '../../web/sanitizer.js'
import { bundleHtmlResources } from '../../web/bundler.js'
import { loadArchiveTree } from '../../archive/main.js'
import {
  openArchiveEntryInViewer,
  closeArchiveSession,
  type ViewerOwnershipLease,
  type CancellationToken,
} from '../../archive/extract.js'
import {
  PasswordRequiredError,
  InvalidPasswordError,
  CancelledError,
} from '../../archive/errors.js'
import { filterAndSortComicEntries } from '../../books/comic.js'
import { readZipCatalog, type ZipEntryInfo } from '../../archive/zip/helper.js'
import { sniffHeaderMagic } from '../../detector.js'
import {
  registerClick,
  registerDismiss,
  registerKey,
  cleanupAllListeners,
  detachAllViewListeners,
} from './viewerListeners.js'
import {
  THEMES,
  getFontNames,
  getFormatLabel,
  getWebLabel,
  getArchiveLabel,
  toColorInt,
  formatFileSize,
  isMainThread,
} from './viewerThemes.js'
import { t } from '../../i18n/index.js'
import {
  dp,
  createRoundedDrawable,
  runOnUiThread,
  getSystemDimension,
  openExternallySafe,
} from './viewerUiUtils.js'
import { ImageTransformController } from '../image/imageTransform.js'
import { WebViewController } from '../web/webController.js'
import { ArchiveBrowserUi, type ArchiveBrowserCallbacks } from '../archive/archiveBrowserUi.js'
import {
  showActionListDialog,
  showFontDialog,
  showThemeDialog,
  showEncodingDialog,
  showFileInfoDialog,
  showActiveContentWarningDialog,
  showJumpToPageDialog,
  promptArchivePassword,
  showArchiveEntryInfoDialog,
  showArchiveInfoDialog,
  type ActionDialogItem,
} from '../dialogs/viewerDialogs.js'

export { THEMES, openExternallySafe }

const activeViewers = new Set<DocViewer>()

export function closeAllViewers(): void {
  detachAllViewListeners()
  for (const viewer of activeViewers) {
    try {
      viewer.dismiss()
    } catch { }
  }
  activeViewers.clear()
}

export interface DocViewerOptions {
  archiveContext?: {
    archivePath: string
    entryPath: string
    archivePassword?: string
    charset?: string
  }
}

export class DocViewer {
  private activity: JavaObject
  private filePath: string
  private fileName: string
  private mimeType: string
  private format: DocumentFormat
  private fileSize: number
  private density = 1.0

  public archiveContext?: {
    archivePath: string
    entryPath: string
    archivePassword?: string
    charset?: string
  }

  private dialog: JavaObject | null = null
  private currentMenuDialog: JavaObject | null = null
  private rootView: JavaObject | null = null
  private scrollView: JavaObject | null = null
  private horizontalScrollView: JavaObject | null = null
  private textView: JavaObject | null = null
  private loadingView: JavaObject | null = null
  private topBar: JavaObject | null = null
  private bottomBox: JavaObject | null = null
  private pager: JavaObject | null = null
  private counterView: JavaObject | null = null
  private prevButton: JavaObject | null = null
  private nextButton: JavaObject | null = null
  private subTitleView: JavaObject | null = null
  private topBarCloseBtn: JavaObject | null = null

  private imageTransform: ImageTransformController | null = null
  private webController: WebViewController | null = null
  private archiveBrowser: ArchiveBrowserUi | null = null

  private isArchive = false
  private isImage = false
  private isPdf = false
  private isWeb = false
  private isComic = false
  private fileExtension = ''

  private isJsAllowedForCurrentDoc = false
  private currentActiveContentReport: ActiveContentReport | null = null
  private rawDocumentHtml: string | null = null
  private webView: JavaObject | null = null

  private pdfDoc: PdfDocument | null = null
  private pdfPageCount = 0
  private imageView: JavaObject | null = null
  private isInverted = false
  private readonly isMinimalMode = false

  public ownershipLease: ViewerOwnershipLease | null = null
  public parentViewer: DocViewer | null = null
  private heldExternalLeases: ViewerOwnershipLease[] = []
  private archivePassword?: string
  private comicEntries: ZipEntryInfo[] = []
  private comicTotalPages = 0
  private comicPageLease: ViewerOwnershipLease | null = null
  private comicCancellationToken: CancellationToken | null = null

  private pages: string[] = []
  private currentPage = 0
  private currentEncoding = 'UTF-8'
  private fontIndex = 0
  private fontSize = 15.0
  private themeIndex = 0
  private isWrapEnabled = true
  private isChromeVisible = true
  private isClosed = false
  private registeredListeners: number[] = []

  constructor(
    activity: JavaObject,
    filePath: string,
    fileName: string,
    mimeType: string,
    format: DocumentFormat,
    fileSize: number,
    options?: DocViewerOptions
  ) {
    this.activity = activity
    this.filePath = filePath
    this.fileName = fileName
    this.mimeType = mimeType
    this.format = format
    this.fileSize = fileSize
    this.archiveContext = options?.archiveContext

    const dotIndex = this.fileName.lastIndexOf('.')
    this.fileExtension = dotIndex !== -1 ? this.fileName.slice(dotIndex + 1).toLowerCase() : ''

    this.isPdf = this.format === 'pdf'
    this.isImage = this.format === 'image'
    this.isComic = this.format === 'comic'
    this.isWeb =
      this.format === 'web' ||
      this.format === 'doc' ||
      this.format === 'docx' ||
      this.format === 'odf' ||
      this.format === 'rtf' ||
      this.format === 'xlsx' ||
      this.format === 'csv'
    this.isArchive = this.format === 'archive'
    this.isInverted = Boolean(settings.get('invert'))
    this.themeIndex = Math.max(0, Math.min(THEMES.length - 1, Number(settings.get('theme') || 0)))
    this.fontSize = Math.max(8, Math.min(34, Number(settings.get('text_size') || 15.0)))
    this.fontIndex = Math.max(0, Math.min(getFontNames().length - 1, Number(settings.get('font') || 0)))
    this.isWrapEnabled = Boolean(settings.get('wrap'))
  }

  setOwnershipLease(lease: ViewerOwnershipLease): void {
    this.ownershipLease = lease
  }

  show(): void {
    const act = this.activity
    const res = act.call('getResources') as JavaObject
    const dm = res.call('getDisplayMetrics') as JavaObject
    this.density = Number(dm.getField('density')) || 1.0

    const statusBarHeight = Math.max(getSystemDimension(res, 'status_bar_height'), dp(48, this.density))
    const navBarHeight = Math.max(getSystemDimension(res, 'navigation_bar_height'), dp(32, this.density))

    let themeStyleId = 0x01030007
    try {
      themeStyleId = Number(inu.jvm.cls('android.R$style').getStaticField('Theme_Black_NoTitleBar_Fullscreen'))
    } catch { }

    const dialog = new (inu.jvm.cls('android.app.Dialog'))(act, themeStyleId)
    this.dialog = dialog

    const win = dialog.call('getWindow') as JavaObject
    try {
      const ColorDrawableCls = inu.jvm.cls('android.graphics.drawable.ColorDrawable')
      const winBg = this.isImage || this.isPdf || this.isComic ? 0xff09090d : THEMES[this.themeIndex].bg
      win.call('setBackgroundDrawable', new ColorDrawableCls(toColorInt(winBg)))

      const attrs = win.call('getAttributes') as JavaObject
      attrs.setField('windowAnimations', 0x01030002)
      win.call('setAttributes', attrs)

      try {
        win.call('setLayout', -1, -1)
      } catch { }

      if (settings.get('keepon')) {
        win.call('addFlags', 128)
      }
    } catch { }

    const FrameLayoutCls = inu.jvm.cls('android.widget.FrameLayout')
    const FrameLayoutLayoutParamsCls = inu.jvm.cls('android.widget.FrameLayout$LayoutParams')
    const TextViewCls = inu.jvm.cls('android.widget.TextView')
    const ScrollViewCls = inu.jvm.cls('android.widget.ScrollView')
    const GravityCls = inu.jvm.cls('android.view.Gravity')

    const root = new FrameLayoutCls(act)
    root.call('setBackgroundColor', toColorInt(this.isImage || this.isPdf || this.isComic ? 0xff09090d : THEMES[this.themeIndex].bg))
    this.rootView = root

    if (this.isImage || this.isPdf || this.isComic) {
      const ImageViewCls = inu.jvm.cls('android.widget.ImageView')
      const ScaleTypeCls = inu.jvm.cls('android.widget.ImageView$ScaleType')

      this.imageTransform = new ImageTransformController(act, this.density, () => this.isClosed)
      this.imageTransform.isInverted = this.isInverted

      const iv = new ImageViewCls(act)
      iv.call('setScaleType', ScaleTypeCls.getStaticField('FIT_CENTER'))
      iv.call('setBackgroundColor', toColorInt(0x00000000))
      this.imageView = iv

      this.imageTransform.setupTouch(iv, () => this.viewSize(), {
        onSingleTap: () => this.toggleChrome(),
        onPagePrev: () => this.goToPage(this.currentPage - 1),
        onPageNext: () => this.goToPage(this.currentPage + 1),
        onSubtitleUpdate: () => this.updateSubtitle(),
        isMinimalMode: this.isMinimalMode,
      })
      root.call('addView', iv, new FrameLayoutLayoutParamsCls(-1, -1))
    } else if (this.isWeb) {
      this.webController = new WebViewController(act, () => this.isClosed, {
        themeIndex: () => this.themeIndex,
        density: () => this.density,
      })
      const wv = this.webController.createWebView()
      this.webView = wv

      const isMd = this.fileExtension === 'md' || this.fileExtension === 'markdown' || this.fileExtension === 'mdown'
      const isOffice = this.format === 'doc' || this.format === 'docx' || this.format === 'odf' || this.format === 'rtf' || this.format === 'xlsx' || this.format === 'csv'
      const bgColor = isMd || isOffice ? THEMES[this.themeIndex].bg : 0xffffffff
      wv.call('setBackgroundColor', toColorInt(bgColor))

      const lp = new FrameLayoutLayoutParamsCls(-1, -1)
      const isSpreadsheet = this.format === 'xlsx' || this.format === 'csv' || (this.format === 'odf' && (this.fileExtension === 'ods' || this.fileExtension === 'ots'))
      lp.call('setMargins', 0, statusBarHeight + dp(76, this.density), 0, isSpreadsheet ? navBarHeight : 0)
      root.call('addView', wv, lp)
    } else if (this.isArchive) {
      this.setupArchiveViews(root, statusBarHeight, navBarHeight)
    } else {
      const sv = new ScrollViewCls(act)
      sv.call('setVerticalScrollBarEnabled', true)
      this.scrollView = sv

      const tv = new TextViewCls(act)
      tv.call('setLineSpacing', 0.0, 1.25)
      tv.call(
        'setPadding',
        dp(18, this.density),
        statusBarHeight + dp(86, this.density),
        dp(18, this.density),
        navBarHeight + dp(130, this.density)
      )
      try {
        tv.call('setTextIsSelectable', true)
      } catch { }

      this.registeredListeners.push(registerClick(tv, () => this.toggleChrome()))
      this.textView = tv
      this.attachTextView()
      this.applyFont()
      this.applyTheme()
      root.call('addView', sv, new FrameLayoutLayoutParamsCls(-1, -1))
    }

    const ld = new TextViewCls(act)
    ld.call('setText', t('common.loading'))
    ld.call('setTextColor', toColorInt(THEMES[this.themeIndex].sub))
    ld.call('setTextSize', 15.0)
    ld.call('setGravity', GravityCls.getStaticField('CENTER'))
    ld.call('setPadding', dp(28, this.density), 0, dp(28, this.density), 0)
    this.loadingView = ld
    root.call('addView', ld, new FrameLayoutLayoutParamsCls(-1, -2, GravityCls.getStaticField('CENTER')))

    this.buildTopBar(root, statusBarHeight)
    if (!this.isImage && !this.isWeb && !this.isArchive) {
      this.buildBottomPager(root, navBarHeight)
    }

    dialog.call('setContentView', root)
    this.registeredListeners.push(registerDismiss(dialog, () => this.cleanup()))
    this.registeredListeners.push(registerKey(dialog, (code, ev) => this.onKey(code, ev)))

    activeViewers.add(this)
    dialog.call('show')
    try {
      (dialog.call('getWindow') as JavaObject).call('setLayout', -1, -1)
    } catch { }

    this.startBackgroundLoad()
  }

  get isClosedState(): boolean {
    return this.isClosed
  }

  private runOnUiThread(action: () => void): void {
    runOnUiThread(this.activity, action, () => this.isClosed)
  }

  dismiss(): void {
    if (this.isClosed) return
    this.detachListeners()

    const doDismiss = () => {
      if (this.currentMenuDialog) {
        try {
          this.currentMenuDialog.call('dismiss')
        } catch { }
        this.currentMenuDialog = null
      }
      if (this.dialog) {
        try {
          this.dialog.call('dismiss')
        } catch { }
      }
      this.cleanup()
    }

    if (isMainThread()) {
      doDismiss()
    } else {
      this.runOnUiThread(doDismiss)
    }
  }

  private detachListeners(): void {
    if (this.imageView) {
      try {
        this.imageView.call('setOnTouchListener', null)
        this.imageView.call('setOnClickListener', null)
      } catch { }
    }
    if (this.dialog) {
      try {
        this.dialog.call('setOnDismissListener', null)
        this.dialog.call('setOnKeyListener', null)
      } catch { }
    }
    if (this.currentMenuDialog) {
      try {
        this.currentMenuDialog.call('setOnDismissListener', null)
        this.currentMenuDialog.call('setOnKeyListener', null)
      } catch { }
    }
  }

  private cleanup(): void {
    if (this.isClosed) return
    this.isClosed = true

    this.isJsAllowedForCurrentDoc = false
    this.currentActiveContentReport = null
    this.rawDocumentHtml = null

    this.savePosition()
    this.detachListeners()

    if (this.currentMenuDialog) {
      try {
        this.currentMenuDialog.call('dismiss')
      } catch { }
      this.currentMenuDialog = null
    }

    if (this.webController) {
      this.webController.dispose()
      this.webController = null
      this.webView = null
    }

    if (this.archiveBrowser) {
      this.archiveBrowser.dispose()
      this.archiveBrowser = null
    }

    if (this.pdfDoc) {
      try {
        this.pdfDoc.close()
      } catch { }
      this.pdfDoc = null
    }

    if (this.imageView) {
      try {
        this.imageView.call('setImageDrawable', null)
        this.imageView.call('setImageBitmap', null)
      } catch { }
      this.imageView = null
    }

    this.imageTransform = null

    cleanupAllListeners(this.registeredListeners)
    this.registeredListeners = []

    if (this.ownershipLease) {
      const lease = this.ownershipLease
      this.ownershipLease = null
      lease.release().catch((err) => console.error('[DocViewer] ownershipLease.release error:', err))
    }

    if (this.comicPageLease) {
      const lease = this.comicPageLease
      this.comicPageLease = null
      lease.release().catch((err) => console.error('[DocViewer] comicPageLease.release error:', err))
    }

    if (this.comicCancellationToken) {
      this.comicCancellationToken.isCancelled = true
      this.comicCancellationToken = null
    }

    for (const lease of this.heldExternalLeases) {
      lease.release().catch(() => { })
    }
    this.heldExternalLeases = []

    if (this.isArchive || this.isComic) {
      closeArchiveSession(this.filePath).catch((err) => {
        console.error('[DocViewer] closeArchiveSession error:', err)
      })
    }

    activeViewers.delete(this)
    this.dialog = null
    this.rootView = null
    this.scrollView = null
    this.horizontalScrollView = null
    this.textView = null
    this.loadingView = null
  }

  private startBackgroundLoad(desiredCharset?: string): void {
    this.runOnUiThread(() => {
      if (this.loadingView) {
        this.loadingView.call('setText', t('common.loading'))
        this.loadingView.call('setVisibility', 0)
      }
    })

    if (
      this.fileExtension === 'tar' ||
      this.fileExtension === 'tgz' ||
      this.fileExtension === 'tbz2' ||
      this.fileExtension === 'txz'
    ) {
      this.runOnUiThread(() => this.showError(t('viewer.unsupportedTar')))
      return
    }

    if (this.fileExtension === 'cbr' || this.fileExtension === 'rar') {
      this.runOnUiThread(() => this.showError(t('viewer.unsupportedRar')))
      return
    }

    if (this.isComic) {
      setTimeout(async () => {
        try {
          const centralDir = readZipCatalog(this.filePath)
          const comicEntries = filterAndSortComicEntries(centralDir.entries)
          if (comicEntries.length === 0) throw new Error(t('viewer.noComicImages'))
          if (this.isClosed) return

          this.comicEntries = comicEntries
          this.comicTotalPages = comicEntries.length

          let startPage = 0
          if (settings.get('remember')) {
            startPage = Math.max(0, Math.min(this.comicTotalPages - 1, this.getSavedPosition()))
          }
          this.currentPage = startPage
          await this.loadComicPage(startPage)
        } catch (err: any) {
          if (this.isClosed) return
          const message = String(err?.message || err)
          this.runOnUiThread(() => this.showError(t('viewer.openFailed', { error: message })))
        }
      }, 0)
      return
    }

    if (this.isPdf) {
      setTimeout(async () => {
        try {
          const doc = openPdfDocument(this.filePath)
          if (this.isClosed) {
            doc.close()
            return
          }
          this.pdfDoc = doc
          this.pdfPageCount = doc.getPageCount()

          let startPage = 0
          if (settings.get('remember')) {
            startPage = Math.max(0, Math.min(this.pdfPageCount - 1, this.getSavedPosition()))
          }
          this.currentPage = startPage
          await this.loadPdfPage(startPage)
        } catch (err: any) {
          if (this.isClosed) return
          const message = String(err?.message || err)
          this.runOnUiThread(() => {
            this.showError(t('viewer.openPdfError', { error: message }))
            try {
              inu.ui
                .dialog({
                  title: t('common.error'),
                  message: `${message}\n\n${t('common.openExternal')}`,
                  positive: t('common.ok'),
                  negative: t('common.cancel'),
                })
                .then((result) => {
                  if (result === 'positive' && this.activity) {
                    openExternallySafe(this.activity, this.filePath, 'application/pdf')
                    this.dismiss()
                  }
                })
            } catch { }
          })
        }
      }, 0)
      return
    }

    if (this.isImage) {
      setTimeout(async () => {
        try {
          const res = this.activity.call('getResources') as JavaObject
          const dm = res.call('getDisplayMetrics') as JavaObject
          const w = Number(dm.getField('widthPixels')) || 1080
          const h = Number(dm.getField('heightPixels')) || 1920

          const decoded = await loadImageBitmapAsync(this.filePath, Math.min(2560, w * 2), Math.min(2560, h * 2))
          if (this.isClosed) {
            try {
              decoded.bitmap.call('recycle')
            } catch { }
            return
          }

          this.runOnUiThread(() => this.onImageLoaded(decoded))
        } catch (err: any) {
          if (this.isClosed) return
          this.runOnUiThread(() => this.showError(String(err?.message || err)))
        }
      }, 0)
      return
    }

    if (this.isWeb) {
      setTimeout(async () => {
        try {
          const currentTheme = THEMES[this.themeIndex]
          const themeColors = {
            bg: currentTheme.cssBg || '#09090d',
            fg: currentTheme.cssFg || '#e0e0e0',
            alt: currentTheme.cssAlt || '#181820',
          }

          const rawHtml = await buildHtmlDocumentAsync(this.filePath, this.format, this.fileExtension, themeColors)

          let bundledHtml = rawHtml
          if (this.format === 'web') {
            bundledHtml = await bundleHtmlResources(rawHtml, {
              filePath: this.filePath,
              archiveContext: this.archiveContext,
            })
          }
          this.rawDocumentHtml = bundledHtml

          if (this.isClosed) return

          if (this.format === 'web') {
            const report = inspectActiveContent(bundledHtml, this.fileExtension)
            this.currentActiveContentReport = report

            if (report.hasActiveContent && !this.isJsAllowedForCurrentDoc) {
              this.runOnUiThread(() => {
                if (this.isClosed) return
                if (this.loadingView) this.loadingView.call('setVisibility', 8)
                this.showJsConfirmationDialog((decision) => {
                  if (decision === 'open_without_js') {
                    this.isJsAllowedForCurrentDoc = false
                    this.loadHtmlIntoWebView(sanitizeHtml(bundledHtml, { allowInlineScripts: false }), false)
                  } else if (decision === 'enable_js') {
                    this.isJsAllowedForCurrentDoc = true
                    this.loadHtmlIntoWebView(sanitizeHtml(bundledHtml, { allowInlineScripts: true }), true)
                  } else {
                    this.dismiss()
                  }
                })
              })
              return
            }

            const enableJs = this.isJsAllowedForCurrentDoc
            this.runOnUiThread(() => {
              this.loadHtmlIntoWebView(sanitizeHtml(bundledHtml, { allowInlineScripts: enableJs }), enableJs)
            })
          } else {
            const isSpreadsheet =
              this.format === 'xlsx' ||
              this.format === 'csv' ||
              (this.format === 'odf' && (this.fileExtension === 'ods' || this.fileExtension === 'ots'))
            this.runOnUiThread(() => this.loadHtmlIntoWebView(rawHtml, isSpreadsheet))
          }
        } catch (err: any) {
          if (this.isClosed) return
          this.runOnUiThread(() => this.showError(t('viewer.loadDocError', { error: String(err?.message || err) })))
        }
      }, 0)
      return
    }

    if (this.isArchive) {
      setTimeout(async () => {
        try {
          const enc = this.archiveBrowser?.archiveEncoding ?? 'auto'
          const charset = desiredCharset || (enc === 'auto' ? undefined : enc)
          const tree = loadArchiveTree(this.filePath, charset)
          if (this.isClosed) return

          if (this.archiveBrowser) {
            this.archiveBrowser.archiveTree = tree
            this.archiveBrowser.currentArchiveFolder = ''
          }

          this.runOnUiThread(() => {
            if (this.isClosed) return
            if (this.loadingView) this.loadingView.call('setVisibility', 8)
            this.renderArchiveCurrentFolder()
            this.updateSubtitle()
          })
        } catch (err: any) {
          if (this.isClosed) return
          const magic = sniffHeaderMagic(this.filePath)
          if (!magic.isZip && magic.isXmlOrText) {
            const fp = this.filePath
            const fn = this.fileName
            const sz = this.fileSize
            this.dismiss()
            launchDocViewerAsync(fp, fn, 'text/plain', 'text', sz).catch(console.error)
            return
          }
          this.runOnUiThread(() => {
            this.showError(t('viewer.readArchiveCatalogError', { error: String(err?.message || err) }))
          })
        }
      }, 0)
      return
    }

    setTimeout(async () => {
      try {
        const doc = await buildDocumentAsync(this.filePath, this.format, this.fileExtension, desiredCharset)
        if (this.isClosed) return
        this.runOnUiThread(() => this.onDocumentLoaded(doc))
      } catch (err: any) {
        if (this.isClosed) return
        this.runOnUiThread(() => this.showError(String(err?.message || err)))
      }
    }, 0)
  }

  private onDocumentLoaded(doc: PaginatedDoc): void {
    this.pages = doc.pages
    this.currentEncoding = doc.encoding || 'UTF-8'

    if (doc.wrap !== undefined) {
      this.isWrapEnabled = doc.wrap
      this.attachTextView()
    }
    if (doc.font !== undefined) {
      this.fontIndex = Math.max(0, Math.min(getFontNames().length - 1, doc.font))
      this.applyFont()
    }

    if (this.loadingView) this.loadingView.call('setVisibility', 8)

    let startPage = 0
    if (settings.get('remember')) {
      startPage = Math.max(0, Math.min(this.pages.length - 1, this.getSavedPosition()))
    }
    this.goToPage(startPage, false)
  }

  private showError(message: string): void {
    if (this.loadingView) {
      this.loadingView.call('setText', message)
      this.loadingView.call('setTextColor', toColorInt(0xffff5555))
      this.loadingView.call('setVisibility', 0)
    }
    inu.ui.toast(message)
  }

  private async loadPdfPage(pageIdx: number): Promise<void> {
    if (!this.pdfDoc || this.isClosed) return
    const res = this.activity.call('getResources') as JavaObject
    const dm = res.call('getDisplayMetrics') as JavaObject
    const w = Number(dm.getField('widthPixels')) || 1080
    const h = Number(dm.getField('heightPixels')) || 1920

    try {
      const bmp = this.pdfDoc.renderPage(pageIdx, w, h)
      if (this.isClosed) return

      this.currentPage = pageIdx
      if (this.imageTransform) {
        this.imageTransform.srcBitmap = bmp
        this.imageTransform.rawWidth = Number(bmp.call('getWidth'))
        this.imageTransform.rawHeight = Number(bmp.call('getHeight'))
      }

      this.runOnUiThread(() => {
        if (this.loadingView) this.loadingView.call('setVisibility', 8)
        this.displayImage(bmp)
        this.updateCounter()
        this.updateSubtitle()
        this.savePosition()
      })

      this.pdfDoc.prefetch(pageIdx - 1, w, h)
      this.pdfDoc.prefetch(pageIdx + 1, w, h)
    } catch (err: any) {
      this.runOnUiThread(() => inu.ui.toast(t('viewer.pageError', { page: pageIdx + 1, error: err?.message || err })))
    }
  }

  private async loadComicPage(pageIdx: number): Promise<void> {
    if (this.isClosed || this.comicTotalPages <= 0 || pageIdx < 0 || pageIdx >= this.comicTotalPages) return

    if (this.comicCancellationToken) {
      this.comicCancellationToken.isCancelled = true
      this.comicCancellationToken = null
    }

    const token: CancellationToken = { isCancelled: false }
    this.comicCancellationToken = token

    const entry = this.comicEntries[pageIdx]
    if (!entry) return

    try {
      const result = await openArchiveEntryInViewer(this.filePath, entry, {
        cancellationToken: token,
        password: this.archivePassword,
      })

      if (token.isCancelled || this.isClosed) {
        result.lease.release().catch(() => { })
        return
      }

      const oldLease = this.comicPageLease
      this.comicPageLease = result.lease
      if (oldLease) oldLease.release().catch(() => { })

      const lowerPath = entry.rawPath.toLowerCase()
      const isJpeg = lowerPath.endsWith('.jpg') || lowerPath.endsWith('.jpeg')
      const decoded = await loadImageBitmapAsync(result.targetPath, 2048, 2048, isJpeg)

      if (token.isCancelled || this.isClosed) return

      this.currentPage = pageIdx
      if (this.imageTransform) {
        this.imageTransform.srcBitmap = decoded.bitmap
        this.imageTransform.rawWidth = decoded.width
        this.imageTransform.rawHeight = decoded.height
      }

      this.runOnUiThread(() => {
        if (token.isCancelled || this.isClosed) return
        if (this.loadingView) this.loadingView.call('setVisibility', 8)
        this.displayImage(decoded.bitmap)
        this.updateCounter()
        this.updateSubtitle()
        this.savePosition()
      })
    } catch (err: any) {
      if (token.isCancelled || this.isClosed || err instanceof CancelledError) return

      if (err instanceof PasswordRequiredError || err instanceof InvalidPasswordError) {
        this.archivePassword = undefined
        const pwd = await promptArchivePassword()
        if (pwd) {
          this.archivePassword = pwd
          return this.loadComicPage(pageIdx)
        }
      }

      this.runOnUiThread(() => inu.ui.toast(t('viewer.pageError', { page: pageIdx + 1, error: String(err?.message || err) })))
    }
  }

  private goToPage(idx: number, animated = true): void {
    const total = this.isPdf ? this.pdfPageCount : this.isComic ? this.comicTotalPages : this.pages.length
    if (total <= 0) return
    const target = Math.max(0, Math.min(total - 1, idx))

    if (this.isPdf) {
      if (target === this.currentPage && this.imageTransform?.srcBitmap) return
      this.loadPdfPage(target).catch(console.error)
      return
    }

    if (this.isComic) {
      if (target === this.currentPage && this.imageTransform?.srcBitmap) return
      this.loadComicPage(target).catch(console.error)
      return
    }

    this.currentPage = target
    const text = this.pages[target] || ''

    if (this.textView) this.textView.call('setText', text)
    if (this.scrollView) this.scrollView.call(animated ? 'smoothScrollTo' : 'scrollTo', 0, 0)
    if (this.horizontalScrollView) this.horizontalScrollView.call(animated ? 'smoothScrollTo' : 'scrollTo', 0, 0)

    this.updateCounter()
    this.updateSubtitle()
    this.savePosition()
  }

  private updateCounter(): void {
    if (!this.counterView) return
    const total = this.isPdf ? this.pdfPageCount : this.isComic ? this.comicTotalPages : this.pages.length
    if (total <= 1) {
      this.pager?.call('setVisibility', 8)
      return
    }

    this.pager?.call('setVisibility', 0)
    this.counterView.call('setText', `${this.currentPage + 1} / ${total}`)

    if (this.prevButton) {
      this.prevButton.call('setEnabled', this.currentPage > 0)
      this.prevButton.call('setAlpha', this.currentPage > 0 ? 1.0 : 0.3)
    }
    if (this.nextButton) {
      this.nextButton.call('setEnabled', this.currentPage < total - 1)
      this.nextButton.call('setAlpha', this.currentPage < total - 1 ? 1.0 : 0.3)
    }
  }

  private updateSubtitle(): void {
    if (!this.subTitleView) return
    const rot = this.imageTransform?.rotDeg ?? 0

    if (this.isPdf) {
      const parts: string[] = ['PDF']
      if (this.pdfPageCount > 1) parts.push(`${t('viewer.pages')}: ${this.pdfPageCount}`)
      if (rot !== 0) parts.push(`+${rot}°`)
      parts.push(formatFileSize(this.fileSize))
      this.subTitleView.call('setText', parts.join(' · '))
      return
    }

    if (this.isComic) {
      const parts: string[] = ['CBZ']
      if (this.comicTotalPages > 1) parts.push(`${t('viewer.pages')}: ${this.comicTotalPages}`)
      if (this.comicEntries[this.currentPage]) {
        parts.push(this.comicEntries[this.currentPage].name || this.comicEntries[this.currentPage].rawPath)
      }
      if (rot !== 0) parts.push(`+${rot}°`)
      parts.push(formatFileSize(this.fileSize))
      this.subTitleView.call('setText', parts.join(' · '))
      return
    }

    if (this.isImage) {
      const parts: string[] = []
      const rw = this.imageTransform?.rawWidth ?? 0
      const rh = this.imageTransform?.rawHeight ?? 0
      if (rw > 0 && rh > 0) {
        const isRotated90 = (rot % 180) !== 0
        parts.push(`${isRotated90 ? rh : rw} × ${isRotated90 ? rw : rh}`)
      } else {
        parts.push(getFormatLabel('image'))
      }
      if (rot !== 0) parts.push(`+${rot}°`)
      parts.push(formatFileSize(this.fileSize))
      this.subTitleView.call('setText', parts.join(' · '))
      return
    }

    if (this.isWeb) {
      const label = this.format === 'web'
        ? getWebLabel(this.fileExtension)
        : (getFormatLabel(this.format) || this.fileExtension.toUpperCase() || 'DOC')
      this.subTitleView.call('setText', [label, formatFileSize(this.fileSize)].join(' · '))
      return
    }

    if (this.isArchive) {
      const tree = this.archiveBrowser?.archiveTree
      if (tree) {
        const parts = [
          getArchiveLabel(this.fileExtension),
          `${tree.totalFilesCount} ${t('archive.totalFiles').toLowerCase()}`,
          formatFileSize(tree.totalUncompressedSize),
        ]
        if (tree.detectedEncoding) parts.push(tree.detectedEncoding)
        this.subTitleView.call('setText', parts.join(' · '))
      } else {
        this.subTitleView.call('setText', `${getArchiveLabel(this.fileExtension)} · ${formatFileSize(this.fileSize)}`)
      }
      return
    }

    const parts = [getFormatLabel(this.format)]
    if (this.pages.length > 1) parts.push(`${t('viewer.pages')}: ${this.pages.length}`)
    parts.push(formatFileSize(this.fileSize))
    this.subTitleView.call('setText', parts.join(' · '))
  }

  private savePosition(): void {
    if (!settings.get('remember')) return
    try {
      const total = this.isPdf ? this.pdfPageCount : this.isComic ? this.comicTotalPages : this.pages.length
      if (total <= 1) return
      settings.saveReadingPosition(this.filePath, this.currentPage, total)
    } catch { }
  }

  private getSavedPosition(): number {
    try {
      const page = settings.getReadingPosition(this.filePath)
      if (typeof page === 'number') return page
    } catch { }
    return 0
  }

  private buildTopBar(root: JavaObject, statusBarHeight: number): void {
    const act = this.activity
    const LinearLayoutCls = inu.jvm.cls('android.widget.LinearLayout')
    const LinearLayoutLayoutParamsCls = inu.jvm.cls('android.widget.LinearLayout$LayoutParams')
    const FrameLayoutLayoutParamsCls = inu.jvm.cls('android.widget.FrameLayout$LayoutParams')
    const TextViewCls = inu.jvm.cls('android.widget.TextView')
    const GravityCls = inu.jvm.cls('android.view.Gravity')
    const TruncateAtCls = inu.jvm.cls('android.text.TextUtils$TruncateAt')
    const TypefaceCls = inu.jvm.cls('android.graphics.Typeface')

    const bar = new LinearLayoutCls(act)
    bar.call('setOrientation', 0)
    bar.call('setGravity', GravityCls.getStaticField('CENTER_VERTICAL'))
    bar.call('setBackground', createRoundedDrawable(THEMES[this.themeIndex].bar, 28, this.density))
    bar.call('setPadding', dp(6, this.density), dp(6, this.density), dp(6, this.density), dp(6, this.density))
    bar.call('setClickable', true)

    const closeBtn = this.createButton('✕', 18, () => {
      if (this.isArchive && this.archiveBrowser && this.archiveBrowser.currentArchiveFolder !== '') {
        this.navigateArchiveUp()
      } else {
        this.dismiss()
      }
    })
    this.topBarCloseBtn = closeBtn
    bar.call('addView', closeBtn)

    const titles = new LinearLayoutCls(act)
    titles.call('setOrientation', 1)

    const nameTv = new TextViewCls(act)
    nameTv.call('setText', this.fileName)
    nameTv.call('setTextColor', toColorInt(0xffffffff))
    nameTv.call('setTextSize', 16.0)
    nameTv.call('setTypeface', TypefaceCls.getStaticField('DEFAULT_BOLD'))
    nameTv.call('setSingleLine', true)
    nameTv.call('setEllipsize', TruncateAtCls.getStaticField('END'))

    const subTv = new TextViewCls(act)
    subTv.call('setTextColor', toColorInt(THEMES[this.themeIndex].sub))
    subTv.call('setTextSize', 12.5)
    subTv.call('setSingleLine', true)
    this.subTitleView = subTv
    this.updateSubtitle()

    titles.call('addView', nameTv)
    titles.call('addView', subTv)

    const tlp = new LinearLayoutLayoutParamsCls(0, -2, 1.0)
    tlp.call('setMargins', dp(12, this.density), 0, dp(8, this.density), 0)
    bar.call('addView', titles, tlp)

    bar.call('addView', this.createButton('•••', 13, () => this.showMenu()))

    const blp = new FrameLayoutLayoutParamsCls(-1, -2, GravityCls.getStaticField('TOP'))
    blp.call('setMargins', dp(12, this.density), statusBarHeight + dp(8, this.density), dp(12, this.density), 0)
    this.topBar = bar
    root.call('addView', bar, blp)
  }

  private buildBottomPager(root: JavaObject, navBarHeight: number): void {
    const act = this.activity
    const LinearLayoutCls = inu.jvm.cls('android.widget.LinearLayout')
    const FrameLayoutLayoutParamsCls = inu.jvm.cls('android.widget.FrameLayout$LayoutParams')
    const TextViewCls = inu.jvm.cls('android.widget.TextView')
    const GravityCls = inu.jvm.cls('android.view.Gravity')
    const TypefaceCls = inu.jvm.cls('android.graphics.Typeface')

    const box = new LinearLayoutCls(act)
    box.call('setOrientation', 0)
    box.call('setGravity', GravityCls.getStaticField('CENTER'))
    box.call('setBackground', createRoundedDrawable(THEMES[this.themeIndex].bar, 28, this.density))
    box.call('setPadding', dp(8, this.density), dp(6, this.density), dp(8, this.density), dp(6, this.density))
    box.call('setClickable', true)

    this.prevButton = this.createButton('‹', 22, () => this.goToPage(this.currentPage - 1))
    box.call('addView', this.prevButton)

    const counter = new TextViewCls(act)
    counter.call('setText', '—')
    counter.call('setTextColor', toColorInt(THEMES[this.themeIndex].sub))
    counter.call('setTextSize', 14.0)
    counter.call('setTypeface', TypefaceCls.getStaticField('DEFAULT_BOLD'))
    counter.call('setGravity', GravityCls.getStaticField('CENTER'))
    counter.call('setPadding', dp(16, this.density), 0, dp(16, this.density), 0)
    counter.call('setClickable', true)
    counter.call('setFocusable', true)

    this.registeredListeners.push(registerClick(counter, () => this.showJumpDialog()))
    this.counterView = counter
    box.call('addView', counter)

    this.nextButton = this.createButton('›', 22, () => this.goToPage(this.currentPage + 1))
    box.call('addView', this.nextButton)

    const blp = new FrameLayoutLayoutParamsCls(-2, -2, GravityCls.getStaticField('BOTTOM') | GravityCls.getStaticField('CENTER_HORIZONTAL'))
    blp.call('setMargins', dp(16, this.density), 0, dp(16, this.density), navBarHeight + dp(12, this.density))
    this.bottomBox = box
    this.pager = box
    root.call('addView', box, blp)
    this.updateCounter()
  }

  private attachTextView(): void {
    if (!this.rootView || !this.textView) return
    const act = this.activity
    const FrameLayoutLayoutParamsCls = inu.jvm.cls('android.widget.FrameLayout$LayoutParams')
    const ScrollViewCls = inu.jvm.cls('android.widget.ScrollView')
    const HorizontalScrollViewCls = inu.jvm.cls('android.widget.HorizontalScrollView')

    if (this.scrollView) {
      try {
        this.scrollView.call('removeAllViews')
        this.rootView.call('removeView', this.scrollView)
      } catch { }
      this.scrollView = null
    }

    if (this.horizontalScrollView) {
      try {
        this.horizontalScrollView.call('removeAllViews')
        this.rootView.call('removeView', this.horizontalScrollView)
      } catch { }
      this.horizontalScrollView = null
    }

    const sv = new ScrollViewCls(act)
    sv.call('setVerticalScrollBarEnabled', true)

    if (this.isWrapEnabled) {
      sv.call('addView', this.textView, new FrameLayoutLayoutParamsCls(-1, -2))
      this.scrollView = sv
      this.rootView.call('addView', sv, 0, new FrameLayoutLayoutParamsCls(-1, -1))
    } else {
      const hsv = new HorizontalScrollViewCls(act)
      hsv.call('setHorizontalScrollBarEnabled', true)
      hsv.call('addView', this.textView, new FrameLayoutLayoutParamsCls(-2, -2))
      sv.call('addView', hsv, new FrameLayoutLayoutParamsCls(-2, -2))
      this.scrollView = sv
      this.horizontalScrollView = hsv
      this.rootView.call('addView', sv, 0, new FrameLayoutLayoutParamsCls(-1, -1))
    }
  }

  private applyTheme(): void {
    const theme = THEMES[this.themeIndex]
    if (this.rootView && !this.isImage && !this.isPdf && !this.isComic) {
      this.rootView.call('setBackgroundColor', toColorInt(theme.bg))
    }
    if (this.textView) this.textView.call('setTextColor', toColorInt(theme.fg))
    if (this.topBar) this.topBar.call('setBackground', createRoundedDrawable(theme.bar, 28, this.density))
    if (this.subTitleView) this.subTitleView.call('setTextColor', toColorInt(theme.sub))
    if (this.bottomBox) this.bottomBox.call('setBackground', createRoundedDrawable(theme.bar, 28, this.density))
    if (this.counterView) this.counterView.call('setTextColor', toColorInt(theme.sub))
    if (this.archiveBrowser) {
      this.archiveBrowser.setThemeIndex(this.themeIndex)
      this.archiveBrowser.renderCurrentFolder(this.getArchiveCallbacks())
    }
  }

  private applyFont(): void {
    if (!this.textView) return
    const TypefaceCls = inu.jvm.cls('android.graphics.Typeface')
    const tf = this.fontIndex === 1
      ? TypefaceCls.getStaticField('SERIF')
      : this.fontIndex === 2
        ? TypefaceCls.getStaticField('MONOSPACE')
        : TypefaceCls.getStaticField('SANS_SERIF')

    this.textView.call('setTypeface', tf as JavaObject)
    this.textView.call('setTextSize', this.fontSize)
  }

  private toggleChrome(): void {
    this.runOnUiThread(() => {
      this.isChromeVisible = !this.isChromeVisible
      const vis = this.isChromeVisible ? 0 : 8
      try { this.topBar?.call('setVisibility', vis) } catch { }
      try { this.bottomBox?.call('setVisibility', vis) } catch { }
      try { this.archiveBrowser?.archiveBreadcrumbsScroll?.call('setVisibility', vis) } catch { }
    })
  }

  private onKey(keyCode: number, event: JavaObject): boolean {
    if (this.isArchive && keyCode === 4) {
      const action = Number(event.call('getAction'))
      if (this.archiveBrowser && this.archiveBrowser.currentArchiveFolder !== '') {
        if (action === 1) this.navigateArchiveUp()
        return true
      }
    }

    if (keyCode !== 24 && keyCode !== 25) return false
    if (!settings.get('volume')) return false

    if (Number(event.call('getAction')) === 0) {
      const step = keyCode === 25 ? 1 : -1
      if (this.isPdf || this.isComic) {
        this.goToPage(this.currentPage + step)
      } else {
        this.volumeScroll(step)
      }
      return true
    }
    return false
  }

  private volumeScroll(direction: number): void {
    if (!this.scrollView) return
    const height = Number(this.scrollView.call('getHeight')) || 1000
    if (this.pages.length <= 1) {
      this.scrollView.call('smoothScrollBy', 0, Math.round(direction * height * 0.85))
    } else {
      const target = this.currentPage + direction
      if (target >= 0 && target < this.pages.length) {
        this.goToPage(target)
      }
    }
  }

  private createButton(text: string, sizeSp: number, onClick: () => void, wDp = 48, hDp = 48): JavaObject {
    const act = this.activity
    const TextViewCls = inu.jvm.cls('android.widget.TextView')
    const LinearLayoutLayoutParamsCls = inu.jvm.cls('android.widget.LinearLayout$LayoutParams')
    const GravityCls = inu.jvm.cls('android.view.Gravity')

    const tv = new TextViewCls(act)
    tv.call('setText', text)
    tv.call('setTextSize', sizeSp)
    tv.call('setTextColor', toColorInt(0xffffffff))
    tv.call('setGravity', GravityCls.getStaticField('CENTER'))
    tv.call('setBackground', createRoundedDrawable(THEMES[this.themeIndex].btn, hDp / 2, this.density))
    tv.call('setLayoutParams', new LinearLayoutLayoutParamsCls(dp(wDp, this.density), dp(hDp, this.density)))
    tv.call('setClickable', true)
    tv.call('setFocusable', true)

    this.registeredListeners.push(
      registerClick(tv, () => {
        this.runOnUiThread(() => {
          try {
            onClick()
          } catch (err) {
            console.error('[DocViewer] button onClick error:', err)
          }
        })
      })
    )
    return tv
  }

  private viewSize(): { w: number; h: number } {
    if (this.rootView) {
      const rw = Number(this.rootView.call('getWidth'))
      const rh = Number(this.rootView.call('getHeight'))
      if (rw > 0 && rh > 0) return { w: rw, h: rh }
    }
    const dm = (this.activity.call('getResources') as JavaObject).call('getDisplayMetrics') as JavaObject
    return {
      w: Number(dm.getField('widthPixels')) || 1080,
      h: Number(dm.getField('heightPixels')) || 1920,
    }
  }

  private onImageLoaded(decoded: DecodedImage): void {
    if (this.loadingView) this.loadingView.call('setVisibility', 8)
    if (this.imageTransform) {
      this.imageTransform.srcBitmap = decoded.bitmap
      this.imageTransform.rawWidth = decoded.width
      this.imageTransform.rawHeight = decoded.height
    }
    this.displayImage(decoded.bitmap)
    this.updateSubtitle()
  }

  private displayImage(src: JavaObject): void {
    this.imageTransform?.displayImage(src, this.imageView!, () => this.viewSize())
  }

  private toggleColorInversion(): void {
    if (this.imageTransform && this.imageView) {
      this.imageTransform.toggleInvert(this.imageView)
      this.isInverted = this.imageTransform.isInverted
    }
  }

  private showImageMenu(): void {
    this.showActionListDialog(t('common.options'), [
      {
        label: t('viewer.invertColors'),
        value: this.imageTransform?.isInverted ? t('common.yes') : t('common.no'),
        action: () => this.toggleColorInversion(),
      },
      {
        label: t('viewer.resetScale'),
        action: () => {
          const s = this.viewSize()
          this.imageTransform?.resetImage(this.imageView, s.w, s.h)
        },
      },
      { label: t('common.fileInfo'), action: () => this.showImageInfo() },
      { label: t('common.openExternal'), action: () => openExternallySafe(this.activity, this.filePath, this.mimeType) },
    ])
  }

  private showImageInfo(): void {
    showFileInfoDialog(
      this.activity,
      {
        fileName: this.fileName,
        filePath: this.filePath,
        formatLabel: getFormatLabel(this.format),
        fileSize: this.fileSize,
        mimeType: this.mimeType,
      },
      this.density,
      this.themeIndex
    )
  }

  private showPdfMenu(): void {
    this.showActionListDialog(t('common.options'), [
      { label: t('viewer.goToPage'), action: () => this.showJumpDialog() },
      {
        label: t('viewer.invertColors'),
        value: this.imageTransform?.isInverted ? t('common.yes') : t('common.no'),
        action: () => this.toggleColorInversion(),
      },
      {
        label: t('viewer.resetScale'),
        action: () => {
          const s = this.viewSize()
          this.imageTransform?.resetImage(this.imageView, s.w, s.h)
        },
      },
      { label: t('common.fileInfo'), action: () => this.showPdfFileInfo() },
      { label: t('common.openExternal'), action: () => openExternallySafe(this.activity, this.filePath, this.mimeType || 'application/pdf') },
    ])
  }

  private showPdfFileInfo(): void {
    showFileInfoDialog(
      this.activity,
      {
        fileName: this.fileName,
        filePath: this.filePath,
        formatLabel: getFormatLabel(this.format),
        fileSize: this.fileSize,
        mimeType: this.mimeType,
        pageCount: this.pdfPageCount,
      },
      this.density,
      this.themeIndex
    )
  }

  private showComicMenu(): void {
    this.showActionListDialog(t('common.options'), [
      { label: t('viewer.goToPage'), action: () => this.showJumpDialog() },
      {
        label: t('viewer.invertColors'),
        value: this.imageTransform?.isInverted ? t('common.yes') : t('common.no'),
        action: () => this.toggleColorInversion(),
      },
      {
        label: t('viewer.resetScale'),
        action: () => {
          const s = this.viewSize()
          this.imageTransform?.resetImage(this.imageView, s.w, s.h)
        },
      },
      { label: t('common.fileInfo'), action: () => this.showComicFileInfo() },
      { label: t('common.openExternal'), action: () => openExternallySafe(this.activity, this.filePath, this.mimeType || 'application/vnd.comicbook+zip') },
    ])
  }

  private showComicFileInfo(): void {
    showFileInfoDialog(
      this.activity,
      {
        fileName: this.fileName,
        filePath: this.filePath,
        formatLabel: getFormatLabel(this.format),
        fileSize: this.fileSize,
        mimeType: this.mimeType,
        pageCount: this.comicTotalPages,
      },
      this.density,
      this.themeIndex
    )
  }

  private loadHtmlIntoWebView(html: string, enableJs: boolean): void {
    if (this.isClosed || !this.webController) return
    if (this.loadingView) this.loadingView.call('setVisibility', 8)
    try {
      this.webController.loadHtml(html, enableJs)
    } catch (err) {
      console.error('[DocViewer] loadHtmlIntoWebView error:', err)
    }
  }

  private zoomWeb(delta: number): void {
    if (!this.webController) return
    if (delta > 0) this.webController.zoomIn()
    else this.webController.zoomOut()
  }

  private showWebMenu(): void {
    const items: ActionDialogItem[] = []

    if (this.format === 'web' && this.currentActiveContentReport?.hasActiveContent) {
      items.push({
        label: this.isJsAllowedForCurrentDoc ? t('security.openWithoutJs') : t('security.enableJs'),
        value: this.isJsAllowedForCurrentDoc ? t('common.enabled') : t('common.disabled'),
        action: () => {
          this.isJsAllowedForCurrentDoc = !this.isJsAllowedForCurrentDoc
          if (this.rawDocumentHtml) {
            const safeHtml = sanitizeHtml(this.rawDocumentHtml, { allowInlineScripts: this.isJsAllowedForCurrentDoc })
            this.loadHtmlIntoWebView(safeHtml, this.isJsAllowedForCurrentDoc)
          }
        },
      })
    }

    items.push(
      { label: `${t('viewer.fontSizeLarger')} (${this.webController?.webZoom ?? 100}%)`, action: () => this.zoomWeb(20) },
      { label: `${t('viewer.fontSizeSmaller')} (${this.webController?.webZoom ?? 100}%)`, action: () => this.zoomWeb(-20) },
      { label: t('viewer.theme'), value: THEMES[this.themeIndex]?.name || '', action: () => this.showThemeDialog() },
      { label: t('common.fileInfo'), action: () => this.showFileInfo() },
      { label: t('common.openExternal'), action: () => openExternallySafe(this.activity, this.filePath, this.mimeType) }
    )
    this.showActionListDialog(t('common.options'), items)
  }

  private showMenu(): void {
    if (this.isImage) return this.showImageMenu()
    if (this.isPdf) return this.showPdfMenu()
    if (this.isComic) return this.showComicMenu()
    if (this.isWeb) return this.showWebMenu()
    if (this.isArchive) return this.showArchiveMenu()

    const items: ActionDialogItem[] = []

    if (this.pages.length > 1) {
      items.push({
        label: t('viewer.goToPage'),
        value: `${this.currentPage + 1} / ${this.pages.length}`,
        action: () => this.showJumpDialog(),
      })
      items.push({ label: t('viewer.toStart'), action: () => this.runOnUiThread(() => this.goToPage(0)) })
      items.push({ label: t('viewer.toEnd'), action: () => this.runOnUiThread(() => this.goToPage(this.pages.length - 1)) })
    }

    items.push({
      label: t('viewer.font'),
      value: getFontNames()[this.fontIndex] || getFontNames()[0],
      action: () => this.showFontDialog(),
    })

    items.push({
      label: t('viewer.fontSizeLarger'),
      value: `${Math.round(this.fontSize)} sp`,
      action: () => {
        this.fontSize = Math.min(34.0, this.fontSize + 1.0)
        settings.set('text_size', this.fontSize)
        this.runOnUiThread(() => this.applyFont())
      },
    })

    items.push({
      label: t('viewer.fontSizeSmaller'),
      value: `${Math.round(this.fontSize)} sp`,
      action: () => {
        this.fontSize = Math.max(8.0, this.fontSize - 1.0)
        settings.set('text_size', this.fontSize)
        this.runOnUiThread(() => this.applyFont())
      },
    })

    items.push({
      label: t('viewer.wordWrap'),
      value: this.isWrapEnabled ? t('common.enabled') : t('common.disabled'),
      action: () => {
        this.isWrapEnabled = !this.isWrapEnabled
        settings.set('wrap', this.isWrapEnabled)
        this.runOnUiThread(() => this.attachTextView())
      },
    })

    items.push({
      label: t('viewer.theme'),
      value: THEMES[this.themeIndex].name,
      action: () => this.showThemeDialog(),
    })

    items.push({
      label: t('viewer.encoding'),
      value: this.currentEncoding,
      action: () => this.showEncodingDialog(),
    })

    items.push({
      label: t('viewer.copyPage'),
      action: async () => {
        try {
          await inu.clipboard.write(this.pages[this.currentPage] || '')
          inu.ui.toast(t('viewer.pageCopied'))
        } catch (err) {
          console.error('[DocViewer] Copy page error:', err)
        }
      },
    })

    items.push({
      label: t('viewer.copyAll'),
      action: async () => {
        try {
          const text = this.pages.join('')
          if (text.length > 900000) {
            inu.ui.toast(t('viewer.textTooLarge'))
            return
          }
          await inu.clipboard.write(text)
          inu.ui.toast(t('viewer.allTextCopied'))
        } catch (err) {
          console.error('[DocViewer] Copy all error:', err)
        }
      },
    })

    items.push({ label: t('common.fileInfo'), action: () => this.showFileInfo() })
    items.push({ label: t('common.openExternal'), action: () => openExternallySafe(this.activity, this.filePath, this.mimeType) })

    this.showActionListDialog(t('common.options'), items)
  }

  private showFontDialog(): void {
    showFontDialog(this.activity, this.fontIndex, this.density, this.themeIndex, (idx) => {
      this.fontIndex = idx
      settings.set('font', idx)
      this.runOnUiThread(() => this.applyFont())
    })
  }

  private showThemeDialog(): void {
    showThemeDialog(this.activity, this.themeIndex, this.density, this.themeIndex, (idx) => {
      this.themeIndex = idx
      settings.set('theme', idx)
      this.runOnUiThread(() => {
        this.applyTheme()
        if (this.isWeb) this.startBackgroundLoad()
      })
    })
  }

  private showEncodingDialog(): void {
    showEncodingDialog(this.activity, this.currentEncoding, this.density, this.themeIndex, (charset) => {
      this.currentEncoding = charset || 'UTF-8'
      this.startBackgroundLoad(charset || undefined)
    })
  }

  private showFileInfo(): void {
    const formatLabel = this.format === 'web'
      ? getWebLabel(this.fileExtension)
      : this.isComic
        ? 'CBZ'
        : this.format === 'archive'
          ? getArchiveLabel(this.fileExtension)
          : (getFormatLabel(this.format) || this.fileExtension.toUpperCase() || this.format.toUpperCase())

    showFileInfoDialog(
      this.activity,
      {
        fileName: this.fileName,
        filePath: this.filePath,
        formatLabel,
        fileSize: this.fileSize,
        mimeType: this.mimeType,
        pageCount: this.pages.length,
      },
      this.density,
      this.themeIndex
    )
  }

  private showJumpDialog(): void {
    const total = this.isPdf ? this.pdfPageCount : this.isComic ? this.comicTotalPages : this.pages.length
    if (total <= 1) return
    showJumpToPageDialog(this.activity, total, this.currentPage, (target) => this.goToPage(target), {
      themeIndex: this.themeIndex,
      density: this.density,
      isClosed: () => this.isClosed,
    })
  }

  private showActionListDialog(title: string, items: ActionDialogItem[], message?: string, onCancel?: () => void): void {
    if (this.currentMenuDialog) {
      try {
        this.currentMenuDialog.call('dismiss')
      } catch { }
      this.currentMenuDialog = null
    }

    this.currentMenuDialog = showActionListDialog(this.activity, title, items, {
      themeIndex: this.themeIndex,
      density: this.density,
      message,
      onCancel,
      isClosed: () => this.isClosed,
    })
  }

  private showJsConfirmationDialog(onDecision: (decision: JsDecision) => void): void {
    showActiveContentWarningDialog(this.activity, this.density, this.themeIndex, onDecision)
  }

  private getArchiveCallbacks(): ArchiveBrowserCallbacks {
    return {
      onOpenChildViewer: (filePath, fileName, mimeType, format, fileSize, lease, archiveContext) => {
        const child = new DocViewer(this.activity, filePath, fileName, mimeType, format, fileSize, { archiveContext })
        child.setOwnershipLease(lease)
        child.parentViewer = this
        this.runOnUiThread(() => {
          try {
            child.show()
          } catch (childErr) {
            console.error('[DocViewer] Failed to show child viewer:', childErr)
            this.heldExternalLeases.push(lease)
            openExternallySafe(this.activity, filePath, mimeType)
          }
        })
      },
      onOpenExternal: (filePath, mimeType, lease) => {
        this.heldExternalLeases.push(lease)
        this.runOnUiThread(() => openExternallySafe(this.activity, filePath, mimeType))
      },
      onShowEntryInfo: (fileItem) => {
        showArchiveEntryInfoDialog(this.activity, fileItem, this.density, this.themeIndex)
      },
      onUpdateSubtitle: () => this.updateSubtitle(),
      isClosed: () => this.isClosed,
    }
  }

  private setupArchiveViews(root: JavaObject, statusBarHeight: number, navBarHeight: number): void {
    if (!this.archiveBrowser) {
      this.archiveBrowser = new ArchiveBrowserUi(this.activity, this.filePath, this.fileName, this.density, this.themeIndex)
    }
    this.archiveBrowser.setTopBarCloseBtn(this.topBarCloseBtn)
    this.archiveBrowser.buildArchiveLayout(root, statusBarHeight, navBarHeight)
  }

  private renderArchiveCurrentFolder(): void {
    this.archiveBrowser?.renderCurrentFolder(this.getArchiveCallbacks())
  }

  private navigateArchiveUp(): boolean {
    return this.archiveBrowser ? this.archiveBrowser.navigateUp(this.getArchiveCallbacks()) : false
  }

  private showArchiveMenu(): void {
    const items: ActionDialogItem[] = [
      {
        label: t('archive.encoding'),
        value: this.archiveBrowser?.archiveEncoding?.toUpperCase() || 'AUTO',
        action: () => this.showArchiveEncodingDialog(),
      },
      {
        label: t('viewer.theme'),
        value: THEMES[this.themeIndex]?.name || '',
        action: () => this.showThemeDialog(),
      },
      { label: t('archive.infoTitle'), action: () => this.showArchiveInfoDialog() },
      { label: t('common.openExternal'), action: () => openExternallySafe(this.activity, this.filePath, this.mimeType) },
    ]
    this.showActionListDialog(t('archive.options'), items)
  }

  private showArchiveEncodingDialog(): void {
    const encodings = ['auto', 'cp866', 'cp1251', 'cp1252', 'utf-8']
    const items = encodings.map((enc) => ({
      label: enc.toUpperCase(),
      value: (this.archiveBrowser?.archiveEncoding || 'auto') === enc ? '✓' : undefined,
      action: () => {
        if (this.archiveBrowser) this.archiveBrowser.archiveEncoding = enc
        inu.ui.toast(t('archive.reloading'))
        this.startBackgroundLoad(enc)
      },
    }))
    this.showActionListDialog(t('archive.encoding'), items)
  }

  private showArchiveInfoDialog(): void {
    if (!this.archiveBrowser?.archiveTree) return
    showArchiveInfoDialog(
      this.activity,
      this.archiveBrowser.archiveTree,
      getArchiveLabel(this.fileExtension),
      this.fileName,
      this.filePath,
      this.fileSize,
      this.density,
      this.themeIndex
    )
  }
}

export async function launchDocViewerAsync(
  filePath: string,
  fileName: string,
  mimeType: string,
  format: DocumentFormat,
  fileSize: number
): Promise<void> {
  let activity: JavaObject | null = null
  try {
    activity = inu.android.getCurrentActivity()
    if (!activity || Boolean(activity.call('isFinishing'))) {
      throw new Error('Activity is unavailable or finishing')
    }

    try {
      closeAllViewers()
    } catch { }

    const currentAct = activity
    let targetFormat = format
    let targetMime = mimeType

    if (format === 'archive' || format === 'comic') {
      const magic = sniffHeaderMagic(filePath)
      if (!magic.isZip && magic.isXmlOrText) {
        targetFormat = 'text'
        targetMime = 'text/plain'
      }
    } else if (format === 'doc') {
      const magic = sniffHeaderMagic(filePath)
      if (magic.isRtf) {
        targetFormat = 'rtf'
      }
    }

    const viewer = new DocViewer(currentAct, filePath, fileName, targetMime, targetFormat, fileSize)

    currentAct.call(
      'runOnUiThread',
      inu.jvm.runnable(() => {
        try {
          if (viewer.isClosedState) return
          viewer.show()
        } catch (showErr: any) {
          console.error('[DocViewer] viewer.show() failed on UI thread:', showErr)
          inu.ui.toast(t('viewer.openFailed', { error: showErr?.message || showErr }))
          try {
            openExternallySafe(currentAct, filePath, mimeType)
          } catch { }
        }
      })
    )
  } catch (err: any) {
    console.error('[DocViewer] Deferred viewer launch failed:', err)
    inu.ui.toast(t('viewer.openFailed', { error: String(err?.message || err) }))

    try {
      const act = activity || inu.android.getCurrentActivity()
      if (act) openExternallySafe(act, filePath, mimeType)
    } catch { }
  }
}