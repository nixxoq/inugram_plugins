import { detectFormat, getCategoryForFormat } from './detector.js'
import { settings } from './settings.js'
import { launchDocViewerAsync } from './viewer/core/viewer.js'

let hookDisposer: Disposer | null = null
let isInterceptionActive = false

const CANONICAL_DESCRIPTOR =
  'openForView(Ljava/io/File;Ljava/lang/String;Ljava/lang/String;Landroid/app/Activity;Lorg/telegram/ui/ActionBar/Theme$ResourcesProvider;Z)Z'

function resolveCanonicalMethod(): JavaMethod {
  const AndroidUtilities = inu.jvm.cls('org.telegram.messenger.AndroidUtilities')
  try {
    return AndroidUtilities.getDeclaredMethod(CANONICAL_DESCRIPTOR)
  } catch { }

  throw new Error(`[DocViewer] Could not resolve AndroidUtilities.openForView: ${CANONICAL_DESCRIPTOR}`)
}

export function registerDocViewerHook(): Disposer {
  const method = resolveCanonicalMethod()
  let rawHookDisposer: Disposer | null = null
  let rawActionDisposer: Disposer | null = null

  try {
    rawHookDisposer = inu.xposed.hookMethod(method, {
      before(ctx) {
        if (isInterceptionActive) return
        isInterceptionActive = true

        try {
          const fileObj = ctx.args[0] as JavaObject | null
          if (!fileObj) return

          let fileName = ctx.args[1] ? String(ctx.args[1]) : ''
          if (!fileName || fileName === 'null') {
            fileName = String(fileObj.call('getName') || '')
          }

          const mimeType = ctx.args[2] ? String(ctx.args[2]) : null
          const format = detectFormat(fileName, mimeType)
          if (!format) return

          const category = getCategoryForFormat(format)
          if (!settings.isCategoryEnabled(category)) return

          if (!Boolean(fileObj.call('exists'))) return
          const length = Number(fileObj.call('length'))
          if (length <= 0 || !Boolean(fileObj.call('canRead'))) return

          const filePath = String(fileObj.call('getAbsolutePath') || '')
          if (!filePath) return

          ctx.setReturnValue(true)

          const safeFileName = fileName
          const safeMime = mimeType || ''
          setTimeout(() => {
            launchDocViewerAsync(filePath, safeFileName, safeMime, format, length).catch((err) => {
              console.error('[DocViewer] Viewer launch error:', err)
            })
          }, 0)
        } catch (err) {
          console.error('[DocViewer] Hook callback error:', err)
        } finally {
          isInterceptionActive = false
        }
      },
    })
    hookDisposer = rawHookDisposer

    rawActionDisposer = inu.registerMessageAction({
      id: 'net.nixxo.doc_viewer.prototype_action',
      text: '[DocViewer] View Document',
      placements: ['bubble', 'selection'],
      visible: (ctx) => Boolean(ctx.messages[0] && ctx.messages[0].mediaType === 'document'),
      callback: (ctx) => {
        const msg = ctx.messages[0]
        if (msg) inu.ui.toast(`Document #${msg.id}`)
      },
    })
  } catch (registrationErr) {
    try { rawHookDisposer?.() } catch { }
    hookDisposer = null
    isInterceptionActive = false
    throw registrationErr
  }

  let disposed = false
  const combinedDisposer = (() => {
    if (disposed) return
    disposed = true

    let disposalErr: unknown = null
    try { rawHookDisposer?.() } catch (err) { disposalErr = err }
    try { rawActionDisposer?.() } catch (err) { if (!disposalErr) disposalErr = err }

    hookDisposer = null
    isInterceptionActive = false
    if (disposalErr) throw disposalErr
  }) as Disposer

  combinedDisposer[Symbol.dispose] = () => { combinedDisposer() }
  return combinedDisposer
}