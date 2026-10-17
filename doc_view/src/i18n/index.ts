import { enDict } from './en.js'
import { ruDict } from './ru.js'
import type { TranslationKey, AppLanguage } from './types.js'

let currentLanguage: AppLanguage = 'en'

export function getLanguage(): AppLanguage {
  return currentLanguage
}

export function setLanguage(lang: AppLanguage | 'system'): void {
  if (lang === 'en' || lang === 'ru') {
    currentLanguage = lang
  } else {
    currentLanguage = detectSystemLanguage()
  }
}

export function detectSystemLanguage(): AppLanguage {
  try {
    const LocaleCls = inu.jvm?.cls?.('java.util.Locale')
    if (LocaleCls) {
      const defaultLocale = LocaleCls.callStatic('getDefault')
      const lang = String(defaultLocale.call('getLanguage') || '').toLowerCase()
      if (lang.startsWith('ru')) return 'ru'
    }
  } catch {}
  return 'en'
}

export function initI18n(initialLang?: AppLanguage | 'system'): void {
  if (initialLang === 'en' || initialLang === 'ru') {
    currentLanguage = initialLang
  } else {
    currentLanguage = detectSystemLanguage()
  }
}

export function t(key: TranslationKey, params?: Record<string, string | number>): string {
  const lang = getLanguage()
  const dict = lang === 'ru' ? ruDict : enDict

  const parts = key.split('.')
  let val: any = dict
  for (const part of parts) {
    if (val && typeof val === 'object' && part in val) {
      val = val[part]
    } else {
      val = undefined
      break
    }
  }

  if (typeof val !== 'string') {
    let fallback: any = enDict
    for (const part of parts) {
      fallback = fallback?.[part]
    }
    val = typeof fallback === 'string' ? fallback : key
  }

  if (!params) return val
  return val.replace(/\{(\w+)\}/g, (_: string, k: string) => (k in params ? String(params[k]) : `{${k}}`))
}

export { enDict } from './en.js'
export { ruDict } from './ru.js'
export type { AppLanguage, TranslationKey, TranslationDictionary } from './types.js'
