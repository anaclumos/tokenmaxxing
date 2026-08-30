import { defineI18n } from 'fumadocs-core/i18n';

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

export function localePath({ locale, path }: { locale: string; path: string }): string {
  if (locale === i18n.defaultLanguage) {
    return path === '' ? '/' : path;
  }
  return `/${locale}${path}`;
}
