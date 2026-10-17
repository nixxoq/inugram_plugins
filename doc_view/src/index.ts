import { settings, createSettingsPage } from './settings.js'
import { initI18n } from './i18n/index.js'
import { registerDocViewerHook } from './hook.js'
import { closeAllViewers } from './viewer/core/viewer.js'

let settingsPage: inu.ui.UIPage | null = null
let settingsDisposer: Disposer | null = null
let hookDisposer: Disposer | null = null

try {
  initI18n(settings.get('language'))
  settingsPage = createSettingsPage()
  settingsDisposer = inu.registerSettings(settingsPage)
  hookDisposer = registerDocViewerHook()
  console.log('[DocViewer] Initialized successfully')
} catch (initErr) {
  console.error('[DocViewer] Initialization failed; rolling back:', initErr)
  try { closeAllViewers() } catch { }
  try { hookDisposer?.() } catch { }
  try { settingsDisposer?.() } catch { }
  try { settingsPage?.dispose() } catch { }

  hookDisposer = null
  settingsDisposer = null
  settingsPage = null

  try { inu.ui.toast('[DocViewer] Initialization failed: check logcat') } catch { }
  throw initErr
}

inu.onUnload(() => {
  try { closeAllViewers() } catch (err) { console.warn('[DocViewer] Close viewers error:', err) }
  try { hookDisposer?.() } catch (err) { console.warn('[DocViewer] Hook dispose error:', err) }
  try { settingsDisposer?.() } catch (err) { console.warn('[DocViewer] Settings dispose error:', err) }
  try { settingsPage?.dispose() } catch (err) { console.warn('[DocViewer] Page dispose error:', err) }

  hookDisposer = null
  settingsDisposer = null
  settingsPage = null
  console.log('[DocViewer] Unloaded successfully')
})