import type { enDict } from './en.js'

export type AppLanguage = 'en' | 'ru'

type Join<K, P> = K extends string | number
  ? P extends string | number
    ? `${K}${'' extends P ? '' : '.'}${P}`
    : never
  : never

type Leaves<T, D extends number = 3> = [D] extends [never]
  ? never
  : T extends object
  ? { [K in keyof T]-?: Join<K, Leaves<T[K], [never, 0, 1, 2][D]>> }[keyof T]
  : ''

export type TranslationKey = Leaves<typeof enDict>
export type TranslationDictionary = typeof enDict

