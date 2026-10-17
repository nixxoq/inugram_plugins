import type { DocViewerSettings, FormatCategory, LanguageSetting } from './types.js'
import { t, setLanguage } from './i18n/index.js'

export const DEFAULT_SETTINGS: DocViewerSettings = {
  pdf: true,
  docs: true,
  books: true,
  text: true,
  web: true,
  image: true,
  archive: true,

  invert: false,
  fitwidth: false,
  remember: true,
  volume: true,
  keepon: true,
  wrap: true,
  prettyjson: true,
  csv_table: true,

  theme: 0,
  font: 0,
  text_size: 15,
  language: 'system',
  history: '{}',
}

const STORAGE_PREFIX = 'doc_view:'

class SettingsManager {
  private cache: DocViewerSettings = { ...DEFAULT_SETTINGS }

  constructor() {
    this.migrateIfNeeded()
    this.load()
  }

  private migrateIfNeeded(): void {
    if (typeof localStorage === 'undefined') return
    try {
      const legacy = localStorage.getItem('doc_viewer_settings')
      if (legacy) {
        const parsed = JSON.parse(legacy)
        if (parsed && typeof parsed === 'object') {
          for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof DocViewerSettings>) {
            if (key in parsed) {
              const val = parsed[key]
              const strVal = typeof val === 'boolean' ? (val ? '1' : '0') : String(val)
              localStorage.setItem(STORAGE_PREFIX + key, strVal)
            }
          }
        }
        localStorage.removeItem('doc_viewer_settings')
      }
    } catch { }
  }

  load(): void {
    if (typeof localStorage === 'undefined') return
    try {
      const loaded: Partial<DocViewerSettings> = {}
      for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof DocViewerSettings>) {
        const item = localStorage.getItem(STORAGE_PREFIX + key)
        if (item === null) {
          loaded[key] = DEFAULT_SETTINGS[key] as any
          continue
        }
        const defaultVal = DEFAULT_SETTINGS[key]
        if (typeof defaultVal === 'boolean') {
          loaded[key] = (item === '1' || item === 'true') as any
        } else if (typeof defaultVal === 'number') {
          const num = Number(item)
          loaded[key] = (!isNaN(num) ? num : defaultVal) as any
        } else {
          loaded[key] = item as any
        }
      }
      this.cache = { ...DEFAULT_SETTINGS, ...loaded }
    } catch {
      this.cache = { ...DEFAULT_SETTINGS }
    }
  }

  get<K extends keyof DocViewerSettings>(key: K): DocViewerSettings[K] {
    if (typeof localStorage !== 'undefined') {
      try {
        const item = localStorage.getItem(STORAGE_PREFIX + key) ?? localStorage.getItem(key)
        if (item !== null) {
          const defaultVal = DEFAULT_SETTINGS[key]
          let parsed: any = item
          if (typeof defaultVal === 'boolean') parsed = item === '1' || item === 'true'
          else if (typeof defaultVal === 'number') {
            const num = Number(item)
            parsed = !isNaN(num) ? num : defaultVal
          }
          this.cache[key] = parsed
          return parsed
        }
      } catch { }
    }
    return this.cache[key] ?? DEFAULT_SETTINGS[key]
  }

  set<K extends keyof DocViewerSettings>(key: K, value: DocViewerSettings[K]): void {
    this.cache[key] = value
    if (typeof localStorage === 'undefined') return
    try {
      const strVal = typeof value === 'boolean' ? (value ? '1' : '0') : String(value)
      localStorage.setItem(STORAGE_PREFIX + key, strVal)
      localStorage.setItem(key, strVal)
    } catch { }
  }

  isCategoryEnabled(cat: FormatCategory): boolean {
    return !!this.cache[cat]
  }
}

export function getPluginVersion(): string {
  try {
    if (typeof inu !== 'undefined') {
      const info = inu?.info?.()
      const header = info?.header
      if (header) {
        const v = header['version']?.[0] || header['@version']?.[0]
        if (v && v.trim()) return v.trim()
      }
      const pluginObj = (inu as any).plugin
      if (pluginObj?.version) return String(pluginObj.version).trim()
      const manifest = (inu as any).manifest
      if (manifest?.version) return String(manifest.version).trim()
    }
  } catch {}
  return '0.1.6'
}

export const GITHUB_REPO_URL = 'https://github.com/nixxoq/inugram_plugins'

export function openGithubRepo(): void {
  try {
    if (typeof inu !== 'undefined' && typeof inu?.openUrl === 'function') {
      inu.openUrl(GITHUB_REPO_URL)
      return
    }
  } catch {}

  try {
    const IntentCls = inu.jvm.cls('android.content.Intent')
    const UriCls = inu.jvm.cls('android.net.Uri')
    const uri = UriCls.callStatic('parse', GITHUB_REPO_URL)
    const ACTION_VIEW = String(IntentCls.getStaticField('ACTION_VIEW'))
    const intent = new IntentCls(ACTION_VIEW, uri)
    const FLAG_ACTIVITY_NEW_TASK = Number(IntentCls.getStaticField('FLAG_ACTIVITY_NEW_TASK'))
    intent.call('addFlags', FLAG_ACTIVITY_NEW_TASK)

    const ApplicationLoaderCls = inu.jvm.cls('org.telegram.messenger.ApplicationLoader')
    const appCtx = ApplicationLoaderCls.getStaticField('applicationContext') as JavaObject
    appCtx.call('startActivity', intent)
  } catch {}
}

export const settings = new SettingsManager()

export function createSettingsPage(): inu.ui.UIPage {
  let page: inu.ui.UIPage | null = null
  const LANG_OPTIONS: LanguageSetting[] = ['system', 'en', 'ru']

  page = inu.ui.settingsPage({
    title: t('settings.title'),
    items: () => {
      const currentLang = settings.get('language') || 'system'
      let selectedLangIdx = LANG_OPTIONS.indexOf(currentLang)
      if (selectedLangIdx === -1) selectedLangIdx = 0

      return [
        inu.ui.button({
          id: 'pref_github_repo',
          text: t('settings.githubRepo'),
          icon: inu.android?.resourceIcon ? inu.android.resourceIcon('msg_link') : inu.icons?.common?.('link'),
          onClick: () => {
            openGithubRepo()
          },
        }),

        inu.ui.header(t('settings.language')),
        inu.ui.select({
          id: 'pref_language',
          text: t('settings.language'),
          items: [
            t('settings.languageSystem'),
            t('settings.languageEn'),
            t('settings.languageRu'),
          ],
          selected: selectedLangIdx,
          onChange: (idx) => {
            const chosen = LANG_OPTIONS[idx] || 'system'
            settings.set('language', chosen)
            setLanguage(chosen)
            page?.invalidate()
          },
        }),

        inu.ui.header(t('settings.formatsHeader')),
        inu.ui.check({
          id: 'fmt_pdf',
          text: 'PDF',
          checked: settings.get('pdf'),
          onChange: (v) => { settings.set('pdf', v); page?.invalidate() },
        }),
        inu.ui.check({
          id: 'fmt_docs',
          text: 'DOC, DOCX, XLSX, PPTX, ODF, RTF, EML',
          checked: settings.get('docs'),
          onChange: (v) => { settings.set('docs', v); page?.invalidate() },
        }),
        inu.ui.check({
          id: 'fmt_books',
          text: t('settings.formatBooks'),
          checked: settings.get('books'),
          onChange: (v) => { settings.set('books', v); page?.invalidate() },
        }),
        inu.ui.check({
          id: 'fmt_text',
          text: 'Text, Code, JSON, CSV, Jupyter',
          checked: settings.get('text'),
          onChange: (v) => { settings.set('text', v); page?.invalidate() },
        }),
        inu.ui.check({
          id: 'fmt_web',
          text: 'Markdown, HTML, SVG',
          checked: settings.get('web'),
          onChange: (v) => { settings.set('web', v); page?.invalidate() },
        }),
        inu.ui.check({
          id: 'fmt_image',
          text: t('settings.formatImages'),
          checked: settings.get('image'),
          onChange: (v) => { settings.set('image', v); page?.invalidate() },
        }),
        inu.ui.check({
          id: 'fmt_archive',
          text: t('settings.formatArchives'),
          checked: settings.get('archive'),
          onChange: (v) => { settings.set('archive', v); page?.invalidate() },
        }),

        inu.ui.header(t('settings.viewingHeader')),
        inu.ui.check({
          id: 'pref_invert',
          text: t('settings.nightMode'),
          checked: settings.get('invert'),
          onChange: (v) => { settings.set('invert', v); page?.invalidate() },
        }),
        inu.ui.check({
          id: 'pref_fitwidth',
          text: t('settings.fitWidth'),
          checked: settings.get('fitwidth'),
          onChange: (v) => { settings.set('fitwidth', v); page?.invalidate() },
        }),
        inu.ui.check({
          id: 'pref_remember',
          text: t('settings.rememberPage'),
          checked: settings.get('remember'),
          onChange: (v) => { settings.set('remember', v); page?.invalidate() },
        }),
        inu.ui.check({
          id: 'pref_volume',
          text: t('settings.volumePaging'),
          checked: settings.get('volume'),
          onChange: (v) => { settings.set('volume', v); page?.invalidate() },
        }),
        inu.ui.check({
          id: 'pref_keepon',
          text: t('settings.keepScreenOn'),
          checked: settings.get('keepon'),
          onChange: (v) => { settings.set('keepon', v); page?.invalidate() },
        }),
        inu.ui.check({
          id: 'pref_wrap',
          text: t('settings.wordWrap'),
          checked: settings.get('wrap'),
          onChange: (v) => { settings.set('wrap', v); page?.invalidate() },
        }),
        inu.ui.check({
          id: 'pref_prettyjson',
          text: t('settings.prettyJson'),
          checked: settings.get('prettyjson'),
          onChange: (v) => { settings.set('prettyjson', v); page?.invalidate() },
        }),
        inu.ui.check({
          id: 'pref_csv_table',
          text: t('settings.csvAsTable'),
          checked: settings.get('csv_table'),
          onChange: (v) => { settings.set('csv_table', v); page?.invalidate() },
        }),

        inu.ui.separator(t('settings.versionFooter', { version: getPluginVersion() })),
      ]
    },
  })

  return page
}