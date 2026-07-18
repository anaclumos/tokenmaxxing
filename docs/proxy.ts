import { NextRequest, NextResponse } from 'next/server';
import type { NextFetchEvent } from 'next/server';
import { isMarkdownPreferred, rewritePath } from 'fumadocs-core/negotiation';
import { createI18nMiddleware } from 'fumadocs-core/i18n/middleware';
import { i18n } from '@/lib/i18n';
import { docsContentRoute } from '@/lib/shared';

// Routes that must never be locale-redirected or markdown-rewritten. With the
// docs mounted at the site root, the og and llms.mdx endpoints (bare and
// locale-prefixed alike) must be excluded before the catch-all page rewrites.
const passthroughPrefixes = [
  '/api/',
  '/_next/',
  '/_vercel/',
  '/llms.txt',
  '/llms-full.txt',
  '/favicon.ico',
  '/og/',
  '/llms.mdx/',
  ...i18n.languages.flatMap((lang) => [`/${lang}/og/`, `/${lang}/llms.mdx/`]),
];

// The default language answers on the bare path (hideLocale: 'default-locale'),
// every other locale on its own prefix; rewrite targets always carry the locale
// because the actual routes live under [lang]. The default language gets NO
// prefixed pattern: a /en/... request must fall through to the i18n middleware
// so it canonicalizes to the bare path instead of serving content at /en.
const localePrefixes = [
  { prefix: '', target: `/${i18n.defaultLanguage}` },
  ...i18n.languages
    .filter((lang) => lang !== i18n.defaultLanguage)
    .map((lang) => ({ prefix: `/${lang}`, target: `/${lang}` })),
];

const rewriteDocs = localePrefixes.map(
  ({ prefix, target }) =>
    rewritePath(`${prefix}{/*path}`, `${target}${docsContentRoute}{/*path}/content.md`).rewrite,
);
const rewriteSuffix = localePrefixes.map(
  ({ prefix, target }) =>
    rewritePath(`${prefix}{/*path}.md`, `${target}${docsContentRoute}{/*path}/content.md`).rewrite,
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
