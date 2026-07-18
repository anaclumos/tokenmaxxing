import { defineI18n } from 'fumadocs-core/i18n';

// Top 30 most used languages by total speakers (Ethnologue 2026), in rank order.
export const i18n = defineI18n({
  defaultLanguage: 'en',
  hideLocale: 'default-locale',
  languages: [
    'en',
    'zh',
    'hi',
    'es',
    'ar',
    'fr',
    'bn',
    'pt',
    'ru',
    'id',
    'ur',
    'de',
    'ja',
    'pcm',
    'arz',
    'mr',
    'vi',
    'te',
    'ha',
    'tr',
    'pnb',
    'sw',
    'tl',
    'ta',
    'yue',
    'wuu',
    'fa',
    'ko',
    'am',
    'th',
  ],
});

const rtlLanguages: readonly string[] = ['ar', 'arz', 'ur', 'pnb', 'fa'];

export function localeDir({ locale }: { locale: string }): 'ltr' | 'rtl' {
  return rtlLanguages.includes(locale) ? 'rtl' : 'ltr';
}

// The default language lives at the bare path (hideLocale: 'default-locale').
export function localePath({ locale, path }: { locale: string; path: string }): string {
  if (locale === i18n.defaultLanguage) {
    return path === '' ? '/' : path;
  }
  return `/${locale}${path}`;
}
