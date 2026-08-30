import { NextRequest, NextResponse } from 'next/server';
import type { NextFetchEvent } from 'next/server';
import { isMarkdownPreferred, rewritePath } from 'fumadocs-core/negotiation';
import { createI18nMiddleware } from 'fumadocs-core/i18n/middleware';
import { i18n } from '@/lib/i18n';
import { docsContentRoute } from '@/lib/shared';

const passthroughPrefixes = [
  '/api/',
  '/_next/',
  '/_vercel/',
  '/llms.txt',
  '/llms-full.txt',
  '/favicon.ico',
];

const rewriteExemptPrefixes = [
  '/og/',
  '/llms.mdx/',
  ...i18n.languages.flatMap((lang) => [`/${lang}/og/`, `/${lang}/llms.mdx/`]),
];

const localePrefixes = [
  ...i18n.languages
    .filter((lang) => lang !== i18n.defaultLanguage)
    .map((lang) => ({ prefix: `/${lang}`, target: `/${lang}` })),
  { prefix: '', target: `/${i18n.defaultLanguage}` },
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

  if (!rewriteExemptPrefixes.some((prefix) => pathname.startsWith(prefix))) {
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
  }

  return i18nMiddleware(request, event);
}
