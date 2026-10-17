import { t } from '../../i18n/index.js'
import type { JsDecision } from '../../types.js'
import type { ArchiveFileItem, ArchiveTree } from '../../archive/tree.js'
import {
  registerClick,
  registerDismiss,
  registerKey,
  cleanupAllListeners,
} from '../core/viewerListeners.js'
import {
  THEMES,
  getFontNames,
  formatFileSize,
  toColorInt,
} from '../core/viewerThemes.js'
import { dp, createRoundedDrawable, runOnUiThread } from '../core/viewerUiUtils.js'
import { SUPPORTED_ENCODINGS } from '../text/textReader.js'

export interface ActionDialogItem {
  label: string
  value?: string
  action: () => void
}

export interface FileInfoParams {
  fileName: string
  filePath: string
  formatLabel: string
  fileSize: number
  mimeType?: string
  pageCount?: number
}

function getThemeColors(themeIdx: number) {
  const isDark = themeIdx === 0
  const isLight = themeIdx === 1
  return {
    cardBgColor: isDark ? 0xff212129 : isLight ? 0xffffffff : 0xffebdcb9,
    titleColor: isDark ? 0xffffffff : isLight ? 0xff1a1a1a : 0xff3d3222,
    textColor: isDark ? 0xfff0f0f5 : isLight ? 0xff222226 : 0xff3d3222,
    valueColor: isDark ? 0x88e0e0e0 : isLight ? 0x881a1a1a : 0x883d3222,
    dividerColor: isDark ? 0x18ffffff : isLight ? 0x12000000 : 0x183d3222,
    inputBgColor: isDark ? 0x22ffffff : isLight ? 0x0c000000 : 0x223d3222,
    btnPrimaryColor: 0xff2979ff,
  }
}

export function showActionListDialog(
  activity: JavaObject,
  title: string,
  items: ActionDialogItem[],
  options?: {
    themeIndex?: number
    density?: number
    message?: string
    onCancel?: () => void
    isClosed?: () => boolean
  }
): JavaObject | null {
  if (options?.isClosed?.() || !activity || Boolean(activity.call('isFinishing'))) return null

  let createdDialog: JavaObject | null = null

  runOnUiThread(activity, () => {
    if (options?.isClosed?.() || !activity || Boolean(activity.call('isFinishing'))) return

    try {
      const DialogCls = inu.jvm.cls('android.app.Dialog')
      const LinearLayoutCls = inu.jvm.cls('android.widget.LinearLayout')
      const LinearLayoutLayoutParamsCls = inu.jvm.cls('android.widget.LinearLayout$LayoutParams')
      const FrameLayoutCls = inu.jvm.cls('android.widget.FrameLayout')
      const FrameLayoutLayoutParamsCls = inu.jvm.cls('android.widget.FrameLayout$LayoutParams')
      const ScrollViewCls = inu.jvm.cls('android.widget.ScrollView')
      const TextViewCls = inu.jvm.cls('android.widget.TextView')
      const ViewCls = inu.jvm.cls('android.view.View')
      const GravityCls = inu.jvm.cls('android.view.Gravity')
      const TypefaceCls = inu.jvm.cls('android.graphics.Typeface')
      const ColorDrawableCls = inu.jvm.cls('android.graphics.drawable.ColorDrawable')

      const density = options?.density || 1.0
      const colors = getThemeColors(options?.themeIndex ?? 0)

      const dm = (activity.call('getResources') as JavaObject).call('getDisplayMetrics') as JavaObject
      const widthPixels = Number(dm.getField('widthPixels')) || 1080
      const heightPixels = Number(dm.getField('heightPixels')) || 1920

      const menuDialog = new DialogCls(activity, 0x01030006)
      menuDialog.call('setCanceledOnTouchOutside', true)

      const win = menuDialog.call('getWindow') as JavaObject
      win.call('setBackgroundDrawable', new ColorDrawableCls(0))
      try {
        win.call('setWindowAnimations', Number(inu.jvm.cls('android.R$style').getStaticField('Animation_Dialog')))
      } catch { }

      const card = new LinearLayoutCls(activity)
      card.call('setOrientation', 1)
      card.call('setBackground', createRoundedDrawable(colors.cardBgColor, 18, density))
      card.call('setClickable', true)

      let isDismissing = false
      let isActionTaken = false
      const dismissDialog = () => {
        if (isDismissing) return
        isDismissing = true
        try { menuDialog.call('dismiss') } catch { }
      }

      const localListeners: number[] = []

      if (title) {
        const titleRow = new LinearLayoutCls(activity)
        titleRow.call('setOrientation', 0)
        titleRow.call('setGravity', GravityCls.getStaticField('CENTER_VERTICAL'))

        const titleTv = new TextViewCls(activity)
        titleTv.call('setText', title)
        titleTv.call('setTextSize', 16.5)
        titleTv.call('setTextColor', toColorInt(colors.titleColor))
        titleTv.call('setTypeface', TypefaceCls.getStaticField('DEFAULT_BOLD'))
        titleTv.call('setPadding', dp(20, density), dp(16, density), dp(8, density), dp(14, density))
        titleRow.call('addView', titleTv, new LinearLayoutLayoutParamsCls(0, -2, 1.0))

        const closeBtn = new TextViewCls(activity)
        closeBtn.call('setText', '✕')
        closeBtn.call('setTextSize', 15.0)
        closeBtn.call('setTextColor', toColorInt(colors.valueColor))
        closeBtn.call('setGravity', GravityCls.getStaticField('CENTER'))
        closeBtn.call('setPadding', dp(16, density), dp(16, density), dp(20, density), dp(14, density))
        localListeners.push(registerClick(closeBtn, () => {
          isActionTaken = false
          dismissDialog()
        }))
        titleRow.call('addView', closeBtn)
        card.call('addView', titleRow)

        const titleDivider = new ViewCls(activity)
        titleDivider.call('setBackgroundColor', toColorInt(colors.dividerColor))
        card.call('addView', titleDivider, new LinearLayoutLayoutParamsCls(-1, Math.max(1, dp(1, density))))

        if (options?.message) {
          const msgTv = new TextViewCls(activity)
          msgTv.call('setText', options.message)
          msgTv.call('setTextSize', 13.5)
          msgTv.call('setTextColor', toColorInt(colors.textColor))
          msgTv.call('setPadding', dp(20, density), dp(12, density), dp(20, density), dp(12, density))
          card.call('addView', msgTv)

          const msgDivider = new ViewCls(activity)
          msgDivider.call('setBackgroundColor', toColorInt(colors.dividerColor))
          card.call('addView', msgDivider, new LinearLayoutLayoutParamsCls(-1, Math.max(1, dp(1, density))))
        }
      }

      const sv = new ScrollViewCls(activity)
      sv.call('setVerticalScrollBarEnabled', true)
      const listLayout = new LinearLayoutCls(activity)
      listLayout.call('setOrientation', 1)

      items.forEach((item, index) => {
        const row = new LinearLayoutCls(activity)
        row.call('setOrientation', 0)
        row.call('setGravity', GravityCls.getStaticField('CENTER_VERTICAL'))
        row.call('setPadding', dp(20, density), dp(13, density), dp(20, density), dp(13, density))
        row.call('setClickable', true)

        const labelTv = new TextViewCls(activity)
        labelTv.call('setText', item.label)
        labelTv.call('setTextSize', 15.0)
        labelTv.call('setTextColor', toColorInt(colors.textColor))
        row.call('addView', labelTv, new LinearLayoutLayoutParamsCls(0, -2, 1.0))

        if (item.value) {
          const valTv = new TextViewCls(activity)
          valTv.call('setText', item.value)
          valTv.call('setTextSize', 13.5)
          valTv.call('setTextColor', toColorInt(item.value === '✓' ? 0xff4caf50 : colors.valueColor))
          if (item.value === '✓') valTv.call('setTypeface', TypefaceCls.getStaticField('DEFAULT_BOLD'))
          valTv.call('setGravity', GravityCls.getStaticField('RIGHT') | GravityCls.getStaticField('CENTER_VERTICAL'))
          row.call('addView', valTv)
        }

        localListeners.push(registerClick(row, () => {
          isActionTaken = true
          try { item.action() } catch (err) { console.error('[DocViewer] Item action error:', err) }
          dismissDialog()
        }))

        listLayout.call('addView', row, new LinearLayoutLayoutParamsCls(-1, -2))

        if (index < items.length - 1) {
          const div = new ViewCls(activity)
          div.call('setBackgroundColor', toColorInt(colors.dividerColor))
          const divLp = new LinearLayoutLayoutParamsCls(-1, Math.max(1, dp(0.5, density)))
          divLp.call('setMargins', dp(20, density), 0, dp(20, density), 0)
          listLayout.call('addView', div, divLp)
        }
      })

      const totalListHeight = items.length * dp(46, density)
      const maxScrollHeight = Math.round(heightPixels * 0.58)
      sv.call('addView', listLayout, new LinearLayoutLayoutParamsCls(-1, -2))
      card.call('addView', sv, new LinearLayoutLayoutParamsCls(-1, totalListHeight > maxScrollHeight ? maxScrollHeight : -2))

      const container = new FrameLayoutCls(activity)
      localListeners.push(registerClick(container, () => {
        isActionTaken = false
        dismissDialog()
      }))

      const cardWidth = Math.min(widthPixels - dp(36, density), dp(340, density))
      container.call('addView', card, new FrameLayoutLayoutParamsCls(cardWidth, -2, GravityCls.getStaticField('CENTER')))

      menuDialog.call('setContentView', container)
      localListeners.push(registerDismiss(menuDialog, () => {
        if (!isActionTaken) options?.onCancel?.()
        cleanupAllListeners(localListeners)
      }))

      createdDialog = menuDialog
      menuDialog.call('show')
    } catch (err) {
      console.error('[DocViewer] showActionListDialog error:', err)
    }
  }, options?.isClosed)

  return createdDialog
}

export function showFontDialog(
  activity: JavaObject,
  currentFontIndex: number,
  density: number,
  themeIndex: number,
  onSelectFont: (index: number) => void
): void {
  const items: ActionDialogItem[] = getFontNames().map((name, idx) => ({
    label: name,
    value: idx === currentFontIndex ? '✓' : undefined,
    action: () => onSelectFont(idx),
  }))
  showActionListDialog(activity, t('viewer.font'), items, { themeIndex, density })
}

export function showThemeDialog(
  activity: JavaObject,
  currentThemeIndex: number,
  density: number,
  themeIndex: number,
  onSelectTheme: (index: number) => void
): void {
  const items: ActionDialogItem[] = THEMES.map((theme, idx) => ({
    label: theme.name,
    value: idx === currentThemeIndex ? '✓' : undefined,
    action: () => onSelectTheme(idx),
  }))
  showActionListDialog(activity, t('viewer.theme'), items, { themeIndex, density })
}

export function showEncodingDialog(
  activity: JavaObject,
  currentEncoding: string,
  density: number,
  themeIndex: number,
  onSelectEncoding: (charset: string) => void
): void {
  const items: ActionDialogItem[] = SUPPORTED_ENCODINGS.map((enc) => ({
    label: enc.charset === '' ? t('text.autoEncoding') : enc.label,
    value: (enc.charset || 'auto').toLowerCase() === (currentEncoding || 'auto').toLowerCase() ? '✓' : undefined,
    action: () => onSelectEncoding(enc.charset),
  }))
  showActionListDialog(activity, t('viewer.encoding'), items, { themeIndex, density })
}

export function showFileInfoDialog(
  activity: JavaObject,
  info: FileInfoParams,
  density: number,
  themeIndex: number
): void {
  const copyToast = (text: string, msg: string) => {
    try {
      inu.clipboard?.write(text)
      inu.ui?.toast(msg)
    } catch { }
  }

  const items: ActionDialogItem[] = [
    { label: t('viewer.fileName'), value: info.fileName, action: () => copyToast(info.fileName, t('viewer.filenameCopied')) },
    { label: t('viewer.format'), value: info.formatLabel, action: () => { } },
    { label: t('viewer.fileSize'), value: `${formatFileSize(info.fileSize)} (${info.fileSize.toLocaleString()} B)`, action: () => { } },
  ]

  if (info.pageCount && info.pageCount > 1) {
    items.push({ label: t('viewer.pages'), value: String(info.pageCount), action: () => { } })
  }
  if (info.mimeType) {
    items.push({ label: t('viewer.mimeType'), value: info.mimeType, action: () => { } })
  }
  items.push({ label: t('viewer.path'), value: info.filePath, action: () => copyToast(info.filePath, t('viewer.pathCopied')) })

  showActionListDialog(activity, t('viewer.fileProperties'), items, { themeIndex, density })
}

export function showActiveContentWarningDialog(
  activity: JavaObject,
  density: number,
  themeIndex: number,
  onDecision: (decision: JsDecision) => void
): void {
  const items: ActionDialogItem[] = [
    { label: t('security.openWithoutJs'), value: '✓', action: () => onDecision('open_without_js') },
    { label: t('security.enableJs'), action: () => onDecision('enable_js') },
    { label: t('security.cancel'), action: () => onDecision('cancel') },
  ]
  showActionListDialog(activity, t('security.jsDetectedTitle'), items, {
    themeIndex,
    density,
    message: t('security.jsDetectedMessage'),
    onCancel: () => onDecision('cancel'),
  })
}

function getEditTextValue(et: JavaObject): string {
  try {
    const raw = et.call('getText')
    return String(raw?.call?.('toString') ?? raw ?? '')
  } catch {
    return ''
  }
}

interface InputDialogOptions {
  title: string
  message?: string
  hint?: string
  defaultValue?: string
  inputType?: number
  themeIndex?: number
  density?: number
  isClosed?: () => boolean
  onConfirm: (value: string) => void
  onCancel?: () => void
}

export function showInputDialog(activity: JavaObject, opts: InputDialogOptions): JavaObject | null {
  if (opts.isClosed?.() || !activity || Boolean(activity.call('isFinishing'))) return null

  let createdDialog: JavaObject | null = null

  runOnUiThread(activity, () => {
    if (opts.isClosed?.() || !activity || Boolean(activity.call('isFinishing'))) return

    try {
      const DialogCls = inu.jvm.cls('android.app.Dialog')
      const LinearLayoutCls = inu.jvm.cls('android.widget.LinearLayout')
      const LinearLayoutLayoutParamsCls = inu.jvm.cls('android.widget.LinearLayout$LayoutParams')
      const FrameLayoutCls = inu.jvm.cls('android.widget.FrameLayout')
      const FrameLayoutLayoutParamsCls = inu.jvm.cls('android.widget.FrameLayout$LayoutParams')
      const TextViewCls = inu.jvm.cls('android.widget.TextView')
      const EditTextCls = inu.jvm.cls('android.widget.EditText')
      const ViewCls = inu.jvm.cls('android.view.View')
      const GravityCls = inu.jvm.cls('android.view.Gravity')
      const TypefaceCls = inu.jvm.cls('android.graphics.Typeface')
      const ColorDrawableCls = inu.jvm.cls('android.graphics.drawable.ColorDrawable')

      const density = opts.density || 1.0
      const colors = getThemeColors(opts.themeIndex ?? 0)

      const dm = (activity.call('getResources') as JavaObject).call('getDisplayMetrics') as JavaObject
      const widthPixels = Number(dm.getField('widthPixels')) || 1080

      const dialog = new DialogCls(activity, 0x01030006)
      dialog.call('setCanceledOnTouchOutside', true)

      const win = dialog.call('getWindow') as JavaObject
      win.call('setBackgroundDrawable', new ColorDrawableCls(0))
      try {
        win.call('setWindowAnimations', Number(inu.jvm.cls('android.R$style').getStaticField('Animation_Dialog')))
        win.call('setSoftInputMode', 5)
      } catch { }

      const card = new LinearLayoutCls(activity)
      card.call('setOrientation', 1)
      card.call('setBackground', createRoundedDrawable(colors.cardBgColor, 18, density))
      card.call('setClickable', true)

      const localListeners: number[] = []
      const hideKeyboard = (v: JavaObject) => {
        try {
          const imm = activity.call('getSystemService', 'input_method') as JavaObject
          imm.call('hideSoftInputFromWindow', v.call('getWindowToken'), 0)
        } catch { }
      }

      let isDismissing = false
      const dismiss = () => {
        if (isDismissing) return
        isDismissing = true
        hideKeyboard(card)
        try { dialog.call('dismiss') } catch { }
      }

      // Title Row
      const titleRow = new LinearLayoutCls(activity)
      titleRow.call('setOrientation', 0)
      titleRow.call('setGravity', GravityCls.getStaticField('CENTER_VERTICAL'))

      const titleTv = new TextViewCls(activity)
      titleTv.call('setText', opts.title)
      titleTv.call('setTextSize', 16.5)
      titleTv.call('setTextColor', toColorInt(colors.titleColor))
      titleTv.call('setTypeface', TypefaceCls.getStaticField('DEFAULT_BOLD'))
      titleTv.call('setPadding', dp(20, density), dp(16, density), dp(8, density), dp(14, density))
      titleRow.call('addView', titleTv, new LinearLayoutLayoutParamsCls(0, -2, 1.0))

      const closeBtn = new TextViewCls(activity)
      closeBtn.call('setText', '✕')
      closeBtn.call('setTextSize', 15.0)
      closeBtn.call('setTextColor', toColorInt(colors.valueColor))
      closeBtn.call('setGravity', GravityCls.getStaticField('CENTER'))
      closeBtn.call('setPadding', dp(16, density), dp(16, density), dp(20, density), dp(14, density))
      localListeners.push(registerClick(closeBtn, () => {
        opts.onCancel?.()
        dismiss()
      }))
      titleRow.call('addView', closeBtn)
      card.call('addView', titleRow)

      const divider = new ViewCls(activity)
      divider.call('setBackgroundColor', toColorInt(colors.dividerColor))
      card.call('addView', divider, new LinearLayoutLayoutParamsCls(-1, Math.max(1, dp(1, density))))

      if (opts.message) {
        const msgTv = new TextViewCls(activity)
        msgTv.call('setText', opts.message)
        msgTv.call('setTextSize', 13.5)
        msgTv.call('setTextColor', toColorInt(colors.valueColor))
        msgTv.call('setPadding', dp(20, density), dp(14, density), dp(20, density), dp(10, density))
        card.call('addView', msgTv)
      }

      const et = new EditTextCls(activity)
      if (opts.inputType !== undefined) et.call('setInputType', opts.inputType)
      et.call('setSingleLine', true)
      et.call('setTextSize', 16.0)
      et.call('setTextColor', toColorInt(colors.textColor))
      et.call('setHintTextColor', toColorInt(colors.valueColor))
      if (opts.hint) et.call('setHint', opts.hint)
      if (opts.defaultValue) et.call('setText', opts.defaultValue)
      et.call('setSelectAllOnFocus', true)
      et.call('setGravity', opts.inputType === 2 ? GravityCls.getStaticField('CENTER') : GravityCls.getStaticField('LEFT'))
      et.call('setBackground', createRoundedDrawable(colors.inputBgColor, 10, density))
      et.call('setPadding', dp(14, density), dp(10, density), dp(14, density), dp(10, density))

      const etLp = new LinearLayoutLayoutParamsCls(-1, -2)
      etLp.call('setMargins', dp(20, density), dp(4, density), dp(20, density), dp(18, density))
      card.call('addView', et, etLp)

      const handleConfirm = () => {
        opts.onConfirm(getEditTextValue(et))
        dismiss()
      }

      localListeners.push(registerKey(dialog, (keyCode, event) => {
        if (keyCode === 66 && Number(event.call('getAction')) === 1) {
          handleConfirm()
          return true
        }
        return false
      }))

      // Buttons
      const btnRow = new LinearLayoutCls(activity)
      btnRow.call('setOrientation', 0)
      btnRow.call('setGravity', GravityCls.getStaticField('RIGHT') | GravityCls.getStaticField('CENTER_VERTICAL'))
      const btnRowLp = new LinearLayoutLayoutParamsCls(-1, -2)
      btnRowLp.call('setMargins', dp(20, density), 0, dp(20, density), dp(16, density))

      const cancelBtn = new TextViewCls(activity)
      cancelBtn.call('setText', t('common.cancel'))
      cancelBtn.call('setTextSize', 14.5)
      cancelBtn.call('setTextColor', toColorInt(colors.valueColor))
      cancelBtn.call('setPadding', dp(14, density), dp(8, density), dp(14, density), dp(8, density))
      localListeners.push(registerClick(cancelBtn, () => {
        opts.onCancel?.()
        dismiss()
      }))
      btnRow.call('addView', cancelBtn)

      const okBtn = new TextViewCls(activity)
      okBtn.call('setText', t('common.ok'))
      okBtn.call('setTextSize', 14.5)
      okBtn.call('setTypeface', TypefaceCls.getStaticField('DEFAULT_BOLD'))
      okBtn.call('setTextColor', toColorInt(0xffffffff))
      okBtn.call('setBackground', createRoundedDrawable(colors.btnPrimaryColor, 8, density))
      okBtn.call('setPadding', dp(18, density), dp(8, density), dp(18, density), dp(8, density))

      const okLp = new LinearLayoutLayoutParamsCls(-2, -2)
      okLp.call('setMargins', dp(8, density), 0, 0, 0)
      localListeners.push(registerClick(okBtn, handleConfirm))
      btnRow.call('addView', okBtn, okLp)

      card.call('addView', btnRow, btnRowLp)

      const container = new FrameLayoutCls(activity)
      localListeners.push(registerClick(container, () => {
        opts.onCancel?.()
        dismiss()
      }))

      const cardWidth = Math.min(widthPixels - dp(48, density), dp(320, density))
      container.call('addView', card, new FrameLayoutLayoutParamsCls(cardWidth, -2, GravityCls.getStaticField('CENTER')))

      dialog.call('setContentView', container)
      localListeners.push(registerDismiss(dialog, () => {
        hideKeyboard(et)
        cleanupAllListeners(localListeners)
      }))

      createdDialog = dialog
      dialog.call('show')
      try {
        et.call('requestFocus')
        et.call('selectAll')
      } catch { }
    } catch (err) {
      console.error('[DocViewer] showInputDialog error:', err)
    }
  }, opts.isClosed)

  return createdDialog
}

export function showJumpToPageDialog(
  activity: JavaObject,
  totalPages: number,
  currentPage: number,
  onPageSelected: (pageIndex: number) => void,
  options?: { themeIndex?: number; density?: number; isClosed?: () => boolean }
): JavaObject | null {
  return showInputDialog(activity, {
    title: t('viewer.goToPage'),
    message: t('viewer.enterPageNumber', { total: totalPages }),
    hint: `1–${totalPages}`,
    defaultValue: String(currentPage + 1),
    inputType: 2, // numeric
    themeIndex: options?.themeIndex,
    density: options?.density,
    isClosed: options?.isClosed,
    onConfirm: (raw) => {
      const num = parseInt(raw.trim(), 10)
      if (!Number.isFinite(num) || num < 1 || num > totalPages) {
        inu.ui?.toast(t('viewer.invalidPageNumber'))
        return
      }
      onPageSelected(num - 1)
    },
  })
}

export function showJsPromptDialog(
  activity: JavaObject,
  message: string,
  defaultValue: string,
  onInput: (value: string | null) => void,
  options?: { themeIndex?: number; density?: number; isClosed?: () => boolean }
): JavaObject | null {
  let settled = false
  return showInputDialog(activity, {
    title: t('security.jsPromptTitle'),
    message,
    defaultValue,
    themeIndex: options?.themeIndex,
    density: options?.density,
    isClosed: options?.isClosed,
    onConfirm: (val) => {
      if (!settled) {
        settled = true
        onInput(val)
      }
    },
    onCancel: () => {
      if (!settled) {
        settled = true
        onInput(null)
      }
    },
  })
}

export function showJsAlertDialog(
  activity: JavaObject,
  message: string,
  onConfirm: () => void,
  options?: { themeIndex?: number; density?: number; isClosed?: () => boolean }
): JavaObject | null {
  return showActionListDialog(activity, t('security.jsAlertTitle'), [{ label: t('common.ok'), action: onConfirm }], {
    themeIndex: options?.themeIndex,
    density: options?.density,
    message,
    onCancel: onConfirm,
    isClosed: options?.isClosed,
  })
}

export function showJsConfirmDialog(
  activity: JavaObject,
  message: string,
  onDecision: (confirmed: boolean) => void,
  options?: { themeIndex?: number; density?: number; isClosed?: () => boolean }
): JavaObject | null {
  return showActionListDialog(
    activity,
    t('security.jsConfirmTitle'),
    [
      { label: t('common.ok'), action: () => onDecision(true) },
      { label: t('common.cancel'), action: () => onDecision(false) },
    ],
    {
      themeIndex: options?.themeIndex,
      density: options?.density,
      message,
      onCancel: () => onDecision(false),
      isClosed: options?.isClosed,
    }
  )
}

export async function promptJumpToPage(totalPages: number): Promise<number | null> {
  const input = await inu.ui?.prompt({
    title: t('viewer.goToPage'),
    hint: t('viewer.enterPageNumber', { total: totalPages }),
  })
  if (!input) return null
  const num = parseInt(input.trim(), 10)
  if (!Number.isFinite(num) || num < 1 || num > totalPages) {
    inu.ui?.toast(t('viewer.invalidPageNumber'))
    return null
  }
  return num - 1
}

export async function promptArchivePassword(): Promise<string | null> {
  const pwd = await inu.ui?.prompt({
    title: t('archive.passwordPromptTitle'),
    hint: t('archive.passwordRequired'),
  })
  return pwd || null
}

export function showArchiveEntryInfoDialog(
  activity: JavaObject,
  fileItem: ArchiveFileItem,
  density: number,
  themeIndex: number
): void {
  const entry = fileItem.entry
  const ratio = entry.size > 0 ? Math.round((1 - entry.compressedSize / entry.size) * 100) : 0
  const methodStr = entry.method === 8 ? t('archive.methodDeflate') : entry.method === 0 ? t('archive.methodStored') : t('archive.methodOther', { method: entry.method })

  const copyToast = (text: string, msg: string) => {
    try {
      inu.clipboard?.write(text)
      inu.ui?.toast(msg)
    } catch { }
  }

  const items: ActionDialogItem[] = [
    { label: t('viewer.fileName'), value: fileItem.basename, action: () => copyToast(fileItem.basename, t('viewer.filenameCopied')) },
    { label: t('archive.originalSize'), value: `${formatFileSize(entry.size)} (${entry.size.toLocaleString()} B)`, action: () => { } },
    { label: t('archive.compressedSize'), value: `${formatFileSize(entry.compressedSize)} (${entry.compressedSize.toLocaleString()} B)`, action: () => { } },
    { label: t('archive.ratio'), value: `-${ratio}%`, action: () => { } },
    { label: t('archive.compressionMethod'), value: methodStr, action: () => { } },
    { label: t('archive.encryption'), value: entry.isEncrypted ? t('common.yes') : t('common.no'), action: () => { } },
    { label: t('archive.modifiedDate'), value: entry.mtimeStr, action: () => { } },
    { label: t('viewer.path'), value: entry.rawPath, action: () => copyToast(entry.rawPath, t('viewer.pathCopied')) },
  ]

  showActionListDialog(activity, t('archive.entryProperties'), items, { themeIndex, density })
}

export function showArchiveInfoDialog(
  activity: JavaObject,
  archiveTree: ArchiveTree,
  formatLabel: string,
  fileName: string,
  filePath: string,
  fileSize: number,
  density: number,
  themeIndex: number
): void {
  const totalRatio = archiveTree.totalUncompressedSize > 0 ? Math.round((1 - fileSize / archiveTree.totalUncompressedSize) * 100) : 0

  const items: ActionDialogItem[] = [
    { label: t('viewer.fileName'), value: fileName, action: () => { inu.clipboard?.write(fileName); inu.ui?.toast(t('viewer.filenameCopied')) } },
    { label: t('viewer.format'), value: formatLabel, action: () => { } },
    { label: t('archive.totalFiles'), value: archiveTree.totalFilesCount.toLocaleString(), action: () => { } },
    { label: t('archive.totalFolders'), value: archiveTree.totalFoldersCount.toLocaleString(), action: () => { } },
    { label: t('archive.unpackedSize'), value: `${formatFileSize(archiveTree.totalUncompressedSize)} (${archiveTree.totalUncompressedSize.toLocaleString()} B)`, action: () => { } },
    { label: t('archive.totalCompression'), value: `-${totalRatio}%`, action: () => { } },
  ]

  if (archiveTree.detectedEncoding) {
    items.push({ label: t('archive.detectedEncoding'), value: archiveTree.detectedEncoding, action: () => { } })
  }
  items.push({ label: t('viewer.path'), value: filePath, action: () => { inu.clipboard?.write(filePath); inu.ui?.toast(t('viewer.pathCopied')) } })

  showActionListDialog(activity, t('archive.infoTitle'), items, { themeIndex, density })
}