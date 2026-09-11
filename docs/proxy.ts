import { NextRequest, NextResponse } from 'next/server';
import { isMarkdownPreferred, rewritePath } from 'fumadocs-core/negotiation';
import { docsContentRoute } from '@/lib/shared';

const passthroughPrefixes = [
  '/api/',
  '/_next/',
  '/_vercel/',
  '/llms.txt',
  '/llms-full.txt',
  '/favicon.ico',
  '/og/',
  `${docsContentRoute}/`,
];

const { rewrite: rewriteDocs } = rewritePath('{/*path}', `${docsContentRoute}{/*path}/content.md`);
const { rewrite: rewriteSuffix } = rewritePath(
  '{/*path}.md',
  `${docsContentRoute}{/*path}/content.md`,
);

export default function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (passthroughPrefixes.some((prefix) => pathname.startsWith(prefix))) {
    return NextResponse.next();
  }

  const suffix = rewriteSuffix(pathname);
  if (suffix) {
    return NextResponse.rewrite(new URL(suffix, request.nextUrl));
  }

  if (isMarkdownPreferred(request)) {
    const result = rewriteDocs(pathname);
    if (result) {
      return NextResponse.rewrite(new URL(result, request.nextUrl));
    }
  }

  return NextResponse.next();
}
