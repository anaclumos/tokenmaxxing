import { source } from '@/lib/source';
import { createFromSource } from 'fumadocs-core/search/server';
import { createTokenizer as createMandarinTokenizer } from '@orama/tokenizers/mandarin';
import { createTokenizer as createJapaneseTokenizer } from '@orama/tokenizers/japanese';

function segmenterTokenizer({ locale }: { locale: string }) {
  const segmenter = new Intl.Segmenter(locale, { granularity: 'word' });

  return {
    language: locale,
    normalizationCache: new Map<string, string>(),
    tokenize(raw: string) {
      const tokens: string[] = [];
      for (const segment of segmenter.segment(raw.toLowerCase())) {
        if (segment.isWordLike) tokens.push(segment.segment);
      }
      return tokens;
    },
  };
}

export const { GET } = createFromSource(source, {
  localeMap: {
    en: { language: 'english' },
    zh: {
      components: { tokenizer: createMandarinTokenizer() },
      search: { threshold: 0, tolerance: 0 },
    },
    hi: { language: 'indian' },
    es: { language: 'spanish' },
    ar: { language: 'arabic' },
    fr: { language: 'french' },
    bn: { components: { tokenizer: segmenterTokenizer({ locale: 'bn' }) } },
    pt: { language: 'portuguese' },
    ru: { language: 'russian' },
    id: { language: 'indonesian' },
    ur: { components: { tokenizer: segmenterTokenizer({ locale: 'ur' }) } },
    de: { language: 'german' },
    ja: {
      components: { tokenizer: createJapaneseTokenizer() },
      search: { threshold: 0, tolerance: 0 },
    },
    pcm: { language: 'english' },
    arz: { language: 'arabic' },
    mr: { language: 'indian' },
    vi: { components: { tokenizer: segmenterTokenizer({ locale: 'vi' }) } },
    te: { components: { tokenizer: segmenterTokenizer({ locale: 'te' }) } },
    ha: { components: { tokenizer: segmenterTokenizer({ locale: 'ha' }) } },
    tr: { language: 'turkish' },
    pnb: { components: { tokenizer: segmenterTokenizer({ locale: 'pnb' }) } },
    sw: { components: { tokenizer: segmenterTokenizer({ locale: 'sw' }) } },
    tl: { components: { tokenizer: segmenterTokenizer({ locale: 'tl' }) } },
    ta: { language: 'tamil' },
    yue: {
      components: { tokenizer: createMandarinTokenizer() },
      search: { threshold: 0, tolerance: 0 },
    },
    wuu: {
      components: { tokenizer: createMandarinTokenizer() },
      search: { threshold: 0, tolerance: 0 },
    },
    fa: { components: { tokenizer: segmenterTokenizer({ locale: 'fa' }) } },
    ko: { components: { tokenizer: segmenterTokenizer({ locale: 'ko' }) } },
    am: { components: { tokenizer: segmenterTokenizer({ locale: 'am' }) } },
    th: { components: { tokenizer: segmenterTokenizer({ locale: 'th' }) } },
  },
});
