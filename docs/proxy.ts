import { NextRequest, NextResponse } from 'next/server';
import type { NextFetchEvent } from 'next/server';
import { isMarkdownPreferred, rewritePath } from 'fumadocs-core/negotiation';
import { createI18nMiddleware } from 'fumadocs-core/i18n/middleware';
import { i18n } from '@/lib/i18n';
import { docsContentRoute, docsRoute } from '@/lib/shared';

// Routes living outside the [lang] segment; they must never be locale-redirected.
const passthroughPrefixes = [
  '/api/',
  '/_next/',
  '/_vercel/',
  '/llms.txt',
  '/llms-full.txt',
  '/favicon.ico',
];

// The default language answers on the bare path (hideLocale: 'default-locale'),
// every other locale on its own prefix; rewrite targets always carry the locale
// because the actual routes live under [lang].
const localePrefixes = [
  { prefix: '', target: `/${i18n.defaultLanguage}` },
  ...i18n.languages.map((lang) => ({ prefix: `/${lang}`, target: `/${lang}` })),
];

const rewriteDocs = localePrefixes.map(
  ({ prefix, target }) =>
    rewritePath(`${prefix}${docsRoute}{/*path}`, `${target}${docsContentRoute}{/*path}/content.md`)
      .rewrite,
);
const rewriteSuffix = localePrefixes.map(
  ({ prefix, target }) =>
    rewritePath(
      `${prefix}${docsRoute}{/*path}.md`,
      `${target}${docsContentRoute}{/*path}/content.md`,
    ).rewrite,
);

const i18nMiddleware = createI18nMiddleware(i18n);

export default function proxy(request: NextRequest, event: NextFetchEvent) {
  const { pathname } = request.nextUrl;

  if (passthroughPrefixes.some((prefix) => pathname.startsWith(prefix))) {
    return NextResponse.next();
  }

  for (const rewrite of rewriteSuffix) {
    const result = rewrite(pathname);
    if (result) {
      return NextResponse.rewrite(new URL(result, request.nextUrl));
    }
  }

  if (isMarkdownPreferred(request)) {
    for (const rewrite of rewriteDocs) {
      const result = rewrite(pathname);
      if (result) {
        return NextResponse.rewrite(new URL(result, request.nextUrl));
      }
    }
  }

  return i18nMiddleware(request, event);
}
