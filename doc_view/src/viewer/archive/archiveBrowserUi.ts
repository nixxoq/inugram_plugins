import { t } from '../../i18n/index.js'
import { toColorInt, formatFileSize, getMimeTypeFromExtension } from '../core/viewerThemes.js'
import { dp, createRoundedDrawable, runOnUiThread } from '../core/viewerUiUtils.js'
import { registerClick, cleanupAllListeners } from '../core/viewerListeners.js'
import {
  openArchiveEntryInViewer,
  type ViewerOwnershipLease,
  type CancellationToken,
} from '../../archive/extract.js'
import {
  PasswordRequiredError,
  InvalidPasswordError,
  CancelledError,
} from '../../archive/errors.js'
import {
  type ArchiveTree,
  type ArchiveFileItem,
  getNodeByPath,
  getParentFolderPath,
  getBreadcrumbs,
} from '../../archive/tree.js'
import { detectFormat } from '../../detector.js'
import { promptArchivePassword } from '../dialogs/viewerDialogs.js'

export interface ArchiveBrowserCallbacks {
  onOpenChildViewer: (
    filePath: string,
    fileName: string,
    mimeType: string,
    format: any,
    fileSize: number,
    lease: ViewerOwnershipLease,
    archiveContext?: {
      archivePath: string
      entryPath: string
      archivePassword?: string
      charset?: string
    }
  ) => void
  onOpenExternal: (filePath: string, mimeType: string, lease: ViewerOwnershipLease) => void
  onShowEntryInfo: (fileItem: ArchiveFileItem) => void
  onUpdateSubtitle: () => void
  isClosed: () => boolean
}

const BADGE_COLORS: Record<string, number> = {
  DOCX: 0xff2b579a, DOC: 0xff2b579a, ODT: 0xff2b579a, RTF: 0xff2b579a,
  XLSX: 0xff217346, XLS: 0xff217346, ODS: 0xff217346, CSV: 0xff217346,
  PPTX: 0xffd24726, PPT: 0xffd24726, ODP: 0xffd24726,
  PDF: 0xffe53935,
  ZIP: 0xffff8f00, TAR: 0xffff8f00, GZ: 0xffff8f00, '7Z': 0xffff8f00, RAR: 0xffff8f00, CBZ: 0xffff8f00,
  JPG: 0xff8e24aa, JPEG: 0xff8e24aa, PNG: 0xff8e24aa, WEBP: 0xff8e24aa, GIF: 0xff8e24aa,
  EPUB: 0xff00897b, FB2: 0xff00897b,
  HTML: 0xff00acc1, HTM: 0xff00acc1, MD: 0xff00acc1, JSON: 0xff00acc1, XML: 0xff00acc1,
}

export class ArchiveBrowserUi {
  private activity: JavaObject
  private archiveFilePath: string
  private archiveFileName: string
  private density: number
  private themeIndex: number

  public archiveTree: ArchiveTree | null = null
  public currentArchiveFolder = ''
  public archiveEncoding = 'auto'
  public archivePassword?: string

  public archiveContainerView: JavaObject | null = null
  public archiveBreadcrumbsScroll: JavaObject | null = null
  public archiveBreadcrumbsLayout: JavaObject | null = null
  public archiveListScroll: JavaObject | null = null
  public archiveListLayout: JavaObject | null = null
  public topBarCloseBtn: JavaObject | null = null

  private archiveItemListeners: number[] = []

  constructor(
    activity: JavaObject,
    archiveFilePath: string,
    archiveFileName: string,
    density = 1.0,
    themeIndex = 0
  ) {
    this.activity = activity
    this.archiveFilePath = archiveFilePath
    this.archiveFileName = archiveFileName
    this.density = density
    this.themeIndex = themeIndex
  }

  public setThemeIndex(idx: number): void {
    this.themeIndex = idx
  }

  public setTopBarCloseBtn(btn: JavaObject | null): void {
    this.topBarCloseBtn = btn
  }

  public buildArchiveLayout(root: JavaObject, statusBarHeight: number, navBarHeight: number): JavaObject {
    const act = this.activity
    const LinearLayoutCls = inu.jvm.cls('android.widget.LinearLayout')
    const LinearLayoutLayoutParamsCls = inu.jvm.cls('android.widget.LinearLayout$LayoutParams')
    const FrameLayoutLayoutParamsCls = inu.jvm.cls('android.widget.FrameLayout$LayoutParams')
    const HorizontalScrollViewCls = inu.jvm.cls('android.widget.HorizontalScrollView')
    const ScrollViewCls = inu.jvm.cls('android.widget.ScrollView')
    const ViewCls = inu.jvm.cls('android.view.View')

    const isDark = this.themeIndex === 0
    const isLight = this.themeIndex === 1
    const dividerColor = isDark ? 0x22ffffff : isLight ? 0x18000000 : 0x223d3222

    const container = new LinearLayoutCls(act)
    container.call('setOrientation', 1)
    this.archiveContainerView = container

    const bcScroll = new HorizontalScrollViewCls(act)
    bcScroll.call('setHorizontalScrollBarEnabled', false)
    this.archiveBreadcrumbsScroll = bcScroll

    const bcLayout = new LinearLayoutCls(act)
    bcLayout.call('setOrientation', 0)
    bcLayout.call('setPadding', dp(14, this.density), dp(8, this.density), dp(14, this.density), dp(8, this.density))
    this.archiveBreadcrumbsLayout = bcLayout

    bcScroll.call('addView', bcLayout, new FrameLayoutLayoutParamsCls(-2, -2))
    container.call('addView', bcScroll, new LinearLayoutLayoutParamsCls(-1, -2))

    const divider = new ViewCls(act)
    divider.call('setBackgroundColor', toColorInt(dividerColor))
    container.call('addView', divider, new LinearLayoutLayoutParamsCls(-1, Math.max(1, dp(1, this.density))))

    const listScroll = new ScrollViewCls(act)
    listScroll.call('setVerticalScrollBarEnabled', true)
    this.archiveListScroll = listScroll

    const listLayout = new LinearLayoutCls(act)
    listLayout.call('setOrientation', 1)
    listLayout.call('setPadding', dp(12, this.density), dp(6, this.density), dp(12, this.density), navBarHeight + dp(24, this.density))
    this.archiveListLayout = listLayout

    listScroll.call('addView', listLayout, new FrameLayoutLayoutParamsCls(-1, -2))
    container.call('addView', listScroll, new LinearLayoutLayoutParamsCls(-1, 0, 1.0))

    const clp = new FrameLayoutLayoutParamsCls(-1, -1)
    clp.call('setMargins', 0, statusBarHeight + dp(72, this.density), 0, 0)
    root.call('addView', container, clp)

    return container
  }

  public renderCurrentFolder(callbacks: ArchiveBrowserCallbacks): void {
    if (!this.archiveTree || !this.archiveListLayout || !this.archiveBreadcrumbsLayout || callbacks.isClosed()) return

    const act = this.activity
    const TextViewCls = inu.jvm.cls('android.widget.TextView')
    const TypefaceCls = inu.jvm.cls('android.graphics.Typeface')

    const isDark = this.themeIndex === 0
    const isLight = this.themeIndex === 1
    const subColor = isDark ? 0x99e0e0e0 : isLight ? 0x991a1a1a : 0x993d3222
    const crumbBgColor = isDark ? 0x22ffffff : isLight ? 0x15000000 : 0x223d3222
    const crumbActiveBgColor = isDark ? 0x44ffffff : isLight ? 0x28000000 : 0x443d3222

    cleanupAllListeners(this.archiveItemListeners)
    this.archiveItemListeners = []

    if (this.topBarCloseBtn) {
      this.topBarCloseBtn.call('setText', this.currentArchiveFolder !== '' ? '←' : '✕')
      this.topBarCloseBtn.call('setTextSize', this.currentArchiveFolder !== '' ? 20.0 : 18.0)
    }

    callbacks.onUpdateSubtitle()

    this.archiveBreadcrumbsLayout.call('removeAllViews')
    const breadcrumbs = getBreadcrumbs(this.archiveFileName, this.currentArchiveFolder)

    for (let i = 0; i < breadcrumbs.length; i++) {
      const crumb = breadcrumbs[i]
      const isLast = i === breadcrumbs.length - 1

      const crumbBtn = new TextViewCls(act)
      crumbBtn.call('setText', crumb.name)
      crumbBtn.call('setTextSize', 13.0)
      crumbBtn.call('setTextColor', toColorInt(isLast ? 0xffffffff : subColor))
      crumbBtn.call('setTypeface', isLast ? TypefaceCls.getStaticField('DEFAULT_BOLD') : TypefaceCls.getStaticField('DEFAULT'))
      crumbBtn.call('setBackground', createRoundedDrawable(toColorInt(isLast ? crumbActiveBgColor : crumbBgColor), 14, this.density))
      crumbBtn.call('setPadding', dp(10, this.density), dp(5, this.density), dp(10, this.density), dp(5, this.density))
      crumbBtn.call('setSingleLine', true)
      crumbBtn.call('setClickable', true)

      if (!isLast) {
        const targetPath = crumb.path
        this.archiveItemListeners.push(registerClick(crumbBtn, () => this.navigateToFolder(targetPath, callbacks)))
      }

      this.archiveBreadcrumbsLayout.call('addView', crumbBtn)

      if (!isLast) {
        const arrow = new TextViewCls(act)
        arrow.call('setText', ' › ')
        arrow.call('setTextSize', 14.0)
        arrow.call('setTextColor', toColorInt(subColor))
        arrow.call('setPadding', dp(2, this.density), 0, dp(2, this.density), 0)
        this.archiveBreadcrumbsLayout.call('addView', arrow)
      }
    }

    if (this.archiveBreadcrumbsScroll) {
      setTimeout(() => {
        try { this.archiveBreadcrumbsScroll?.call('fullScroll', 66) } catch { }
      }, 50)
    }

    this.archiveListLayout.call('removeAllViews')
    const folderNode = getNodeByPath(this.archiveTree, this.currentArchiveFolder)

    if (!folderNode) {
      const errTv = new TextViewCls(act)
      errTv.call('setText', t('archive.emptyFolder'))
      errTv.call('setTextColor', toColorInt(0xffff5555))
      errTv.call('setPadding', dp(16, this.density), dp(24, this.density), dp(16, this.density), dp(24, this.density))
      this.archiveListLayout.call('addView', errTv)
      return
    }

    if (this.currentArchiveFolder !== '') {
      this.archiveListLayout.call('addView', this.createArchiveListRow(
        null,
        '..',
        t('archive.upLevel'),
        '↑',
        () => this.navigateUp(callbacks)
      ))
    }

    for (const subfolder of folderNode.folders.values()) {
      const subInfo = t('archive.subfolderSummary', {
        count: subfolder.totalSubFilesCount,
        size: formatFileSize(subfolder.totalSubSize),
      })
      this.archiveListLayout.call('addView', this.createArchiveListRow(
        null,
        subfolder.name,
        subInfo,
        '›',
        () => this.navigateToFolder(subfolder.path, callbacks)
      ))
    }

    for (const fileItem of folderNode.files) {
      const entry = fileItem.entry
      const fileBadge = this.createFileTypeBadge(fileItem)
      const ratio = entry.size > 0 ? Math.round((1 - entry.compressedSize / entry.size) * 100) : 0
      const methodLabel =
        entry.method === 8
          ? t('archive.methodDeflate')
          : entry.method === 0
            ? t('archive.methodStored')
            : t('archive.methodOther', { method: entry.method })

      const subInfo = t('archive.fileSummary', {
        size: formatFileSize(entry.size),
        cSize: formatFileSize(entry.compressedSize),
        ratio: String(ratio),
        date: entry.mtimeStr,
      })

      const badge = entry.isEncrypted ? `ENC · ${methodLabel}` : methodLabel

      this.archiveListLayout.call('addView', this.createArchiveListRow(
        fileBadge,
        fileItem.basename,
        subInfo,
        badge,
        () => this.openArchiveEntry(fileItem, callbacks),
        () => callbacks.onShowEntryInfo(fileItem)
      ))
    }
  }

  public navigateToFolder(path: string, callbacks: ArchiveBrowserCallbacks): void {
    this.currentArchiveFolder = path
    this.renderCurrentFolder(callbacks)
  }

  public navigateUp(callbacks: ArchiveBrowserCallbacks): boolean {
    if (this.currentArchiveFolder === '') return false
    this.currentArchiveFolder = getParentFolderPath(this.currentArchiveFolder)
    this.renderCurrentFolder(callbacks)
    return true
  }

  private createFileTypeBadge(fileItem: ArchiveFileItem): JavaObject {
    const act = this.activity
    const TextViewCls = inu.jvm.cls('android.widget.TextView')
    const TypefaceCls = inu.jvm.cls('android.graphics.Typeface')
    const GravityCls = inu.jvm.cls('android.view.Gravity')

    const dotIdx = fileItem.basename.lastIndexOf('.')
    const ext = dotIdx !== -1 ? fileItem.basename.slice(dotIdx + 1).toUpperCase() : 'FILE'
    const shortExt = ext.length > 4 ? ext.slice(0, 3) : ext
    const badgeColor = BADGE_COLORS[ext] || 0xff607d8b

    const tv = new TextViewCls(act)
    tv.call('setText', shortExt)
    tv.call('setTextSize', 10.0)
    tv.call('setTextColor', toColorInt(badgeColor))
    tv.call('setTypeface', TypefaceCls.getStaticField('DEFAULT_BOLD'))
    tv.call('setGravity', GravityCls.getStaticField('CENTER'))
    tv.call('setBackground', createRoundedDrawable(toColorInt(badgeColor & 0x22ffffff), 6, this.density))
    tv.call('setPadding', dp(6, this.density), dp(4, this.density), dp(6, this.density), dp(4, this.density))
    return tv
  }

  private createArchiveListRow(
    leftBadge: JavaObject | null,
    title: string,
    subtitle: string,
    rightBadgeText: string,
    onClick: () => void,
    onLongClick?: () => void
  ): JavaObject {
    const act = this.activity
    const LinearLayoutCls = inu.jvm.cls('android.widget.LinearLayout')
    const LinearLayoutLayoutParamsCls = inu.jvm.cls('android.widget.LinearLayout$LayoutParams')
    const TextViewCls = inu.jvm.cls('android.widget.TextView')
    const GravityCls = inu.jvm.cls('android.view.Gravity')
    const TypefaceCls = inu.jvm.cls('android.graphics.Typeface')

    const isDark = this.themeIndex === 0
    const isLight = this.themeIndex === 1
    const titleColor = isDark ? 0xfff0f0f5 : isLight ? 0xff222226 : 0xff3d3222
    const subColor = isDark ? 0x88e0e0e0 : isLight ? 0x881a1a1a : 0x883d3222
    const cardBgColor = isDark ? 0x14ffffff : isLight ? 0x08000000 : 0x143d3222

    const row = new LinearLayoutCls(act)
    row.call('setOrientation', 0)
    row.call('setGravity', GravityCls.getStaticField('CENTER_VERTICAL'))
    row.call('setBackground', createRoundedDrawable(toColorInt(cardBgColor), 10, this.density))
    row.call('setPadding', dp(14, this.density), dp(10, this.density), dp(14, this.density), dp(10, this.density))
    row.call('setClickable', true)

    const rlp = new LinearLayoutLayoutParamsCls(-1, -2)
    rlp.call('setMargins', 0, dp(3, this.density), 0, dp(3, this.density))
    row.call('setLayoutParams', rlp)

    if (leftBadge) {
      row.call('addView', leftBadge)
      row.call('addView', new LinearLayoutCls(act), new LinearLayoutLayoutParamsCls(dp(10, this.density), 1))
    }

    const textCol = new LinearLayoutCls(act)
    textCol.call('setOrientation', 1)

    const titleTv = new TextViewCls(act)
    titleTv.call('setText', title)
    titleTv.call('setTextSize', 14.5)
    titleTv.call('setTextColor', toColorInt(titleColor))
    titleTv.call('setTypeface', TypefaceCls.getStaticField('DEFAULT_BOLD'))
    titleTv.call('setSingleLine', true)
    textCol.call('addView', titleTv)

    if (subtitle) {
      const subTv = new TextViewCls(act)
      subTv.call('setText', subtitle)
      subTv.call('setTextSize', 12.0)
      subTv.call('setTextColor', toColorInt(subColor))
      subTv.call('setSingleLine', true)
      textCol.call('addView', subTv)
    }

    row.call('addView', textCol, new LinearLayoutLayoutParamsCls(0, -2, 1.0))

    if (rightBadgeText) {
      const rightTv = new TextViewCls(act)
      rightTv.call('setText', rightBadgeText)
      rightTv.call('setTextSize', 12.0)
      rightTv.call('setTextColor', toColorInt(subColor))
      rightTv.call('setGravity', GravityCls.getStaticField('RIGHT') | GravityCls.getStaticField('CENTER_VERTICAL'))
      row.call('addView', rightTv)
    }

    this.archiveItemListeners.push(registerClick(row, onClick))
    return row
  }

  public async openArchiveEntry(
    fileItem: ArchiveFileItem,
    callbacks: ArchiveBrowserCallbacks,
    forceExternal = false
  ): Promise<void> {
    const entry = fileItem.entry

    if (entry.isEncrypted && entry.method === 99) {
      runOnUiThread(this.activity, () => inu.ui?.toast(t('archive.unsupportedAes')))
      return
    }

    if (entry.method !== 0 && entry.method !== 8) {
      runOnUiThread(this.activity, () => inu.ui?.toast(t('archive.unsupportedMethod', { method: entry.method })))
      return
    }

    let password = this.archivePassword
    if (entry.isEncrypted && !password) {
      const pwd = await promptArchivePassword()
      if (!pwd) return
      password = pwd
      this.archivePassword = pwd
    }

    runOnUiThread(this.activity, () => inu.ui?.toast(t('archive.extracting', { name: fileItem.basename })))
    const token: CancellationToken = { isCancelled: false }

    try {
      const result = await openArchiveEntryInViewer(this.archiveFilePath, entry, {
        cancellationToken: token,
        password,
      })

      if (callbacks.isClosed()) {
        result.lease.release().catch(() => { })
        return
      }

      const mime = getMimeTypeFromExtension(fileItem.basename)
      const format = detectFormat(fileItem.basename, mime)

      if (!forceExternal && format) {
        callbacks.onOpenChildViewer(
          result.targetPath,
          fileItem.basename,
          mime,
          format,
          entry.size,
          result.lease,
          {
            archivePath: this.archiveFilePath,
            entryPath: entry.rawPath,
            archivePassword: this.archivePassword,
            charset: this.archiveEncoding === 'auto' ? this.archiveTree?.detectedEncoding : this.archiveEncoding,
          }
        )
      } else {
        callbacks.onOpenExternal(result.targetPath, mime, result.lease)
      }
    } catch (err: any) {
      if (err instanceof PasswordRequiredError || err instanceof InvalidPasswordError) {
        this.archivePassword = undefined
        runOnUiThread(this.activity, () => {
          inu.ui?.toast(err instanceof InvalidPasswordError ? t('archive.invalidPassword') : t('archive.passwordRequired'))
        })
        return
      }
      if (err instanceof CancelledError) return
      runOnUiThread(this.activity, () => inu.ui?.toast(t('archive.extractionError', { error: String(err?.message || err) })))
    }
  }

  public dispose(): void {
    cleanupAllListeners(this.archiveItemListeners)
    this.archiveItemListeners = []
    this.archiveTree = null
    this.archiveContainerView = null
    this.archiveBreadcrumbsScroll = null
    this.archiveBreadcrumbsLayout = null
    this.archiveListScroll = null
    this.archiveListLayout = null
    this.topBarCloseBtn = null
  }
}