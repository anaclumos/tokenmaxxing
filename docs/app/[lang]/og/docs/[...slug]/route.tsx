import { getPageImage, source } from '@/lib/source';
import { i18n } from '@/lib/i18n';
import { notFound } from 'next/navigation';
import { ImageResponse } from 'next/og';
import { generate as DefaultImage } from 'fumadocs-ui/og';
import { appName } from '@/lib/shared';

export const revalidate = false;

// Renders the default-language page regardless of the lang segment: see the
// satori shaping constraint documented at getPageImage in lib/source.ts.
export async function GET(_req: Request, { params }: RouteContext<'/[lang]/og/docs/[...slug]'>) {
  const { slug } = await params;
  const page = source.getPage(slug.slice(0, -1), i18n.defaultLanguage);
  if (!page) notFound();

  return new ImageResponse(
    <DefaultImage title={page.data.title} description={page.data.description} site={appName} />,
    {
      width: 1200,
      height: 630,
    },
  );
}

export function generateStaticParams() {
  return source.getPages(i18n.defaultLanguage).map((page) => ({
    lang: i18n.defaultLanguage,
    slug: getPageImage(page).segments,
  }));
}
