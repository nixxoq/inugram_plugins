import { toColorInt, formatFileSize, isMainThread } from './viewerThemes.js'

export { toColorInt, formatFileSize, isMainThread }

export function dp(v: number, density = 1.0): number {
  return Math.round(v * density)
}

export function createRoundedDrawable(color: number, radiusDp: number, density = 1.0): JavaObject {
  const GradientDrawableCls = inu.jvm.cls('android.graphics.drawable.GradientDrawable')
  const d = new GradientDrawableCls()
  d.call('setColor', toColorInt(color))
  d.call('setCornerRadius', radiusDp * density)
  return d
}

export function getSystemDimension(res: JavaObject, name: string): number {
  try {
    const id = Number(res.call('getIdentifier', name, 'dimen', 'android'))
    if (id > 0) return Number(res.call('getDimensionPixelSize', id))
  } catch {}
  return 0
}

export function runOnUiThread(
  activity: JavaObject | null,
  action: () => void,
  isClosed?: () => boolean
): void {
  if (isClosed && isClosed()) return

  try {
    if (isMainThread()) {
      try {
        if (!isClosed || !isClosed()) {
          action()
        }
      } catch (err) {
        console.error('[DocViewer] UI operation error:', err)
      }
      return
    }

    if (activity && !Boolean(activity.call('isFinishing'))) {
      activity.call(
        'runOnUiThread',
        inu.jvm.runnable(() => {
          try {
            if (!isClosed || !isClosed()) {
              action()
            }
          } catch (err) {
            console.error('[DocViewer] runOnUiThread error:', err)
          }
        })
      )
    }
  } catch (err) {
    console.error('[DocViewer] failed to dispatch to main thread:', err)
  }
}

export function openExternallySafe(act: JavaObject, filePath: string, mimeType: string): void {
  try {
    try {
      const StrictModeCls = inu.jvm.cls('android.os.StrictMode')
      const BuilderCls = inu.jvm.cls('android.os.StrictMode$VmPolicy$Builder')
      const builder = new BuilderCls()
      StrictModeCls.callStatic('setVmPolicy', builder.call('build'))
    } catch {}

    const FileCls = inu.jvm.cls('java.io.File')
    const IntentCls = inu.jvm.cls('android.content.Intent')
    const file = new FileCls(filePath)

    let uri: JavaObject
    try {
      const FileProviderCls = inu.jvm.cls('androidx.core.content.FileProvider')
      const pkg = String(act.call('getPackageName'))
      uri = FileProviderCls.callStatic('getUriForFile', act, `${pkg}.provider`, file) as JavaObject
    } catch {
      const UriCls = inu.jvm.cls('android.net.Uri')
      uri = UriCls.callStatic('fromFile', file) as JavaObject
    }

    const intent = new IntentCls(IntentCls.getStaticField('ACTION_VIEW'))
    intent.call('setDataAndType', uri, mimeType || 'text/plain')
    intent.call('addFlags', 1) // FLAG_GRANT_READ_URI_PERMISSION

    const chooser = IntentCls.callStatic('createChooser', intent, 'Open file')
    act.call('startActivity', chooser)
  } catch (err) {
    console.error('[DocViewer] openExternallySafe failed:', err)
  }
}
