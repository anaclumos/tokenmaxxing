import { docs } from 'collections/server';
import { loader } from 'fumadocs-core/source';
import { lucideIconsPlugin } from 'fumadocs-core/source/lucide-icons';
import { i18n, localePath } from './i18n';
import { docsContentRoute, docsImageRoute } from './shared';

// See https://fumadocs.dev/docs/headless/source-api for more info
export const source = loader({
  baseUrl: '/',
  i18n,
  source: docs.toFumadocsSource(),
  plugins: [lucideIconsPlugin()],
});

function pageRoutePrefix(page: (typeof source)['$inferPage']) {
  const locale = page.locale ?? i18n.defaultLanguage;
  return localePath({ locale, path: '' }) === '/' ? '' : `/${locale}`;
}

// OG images always come from the default-language page. Satori does not
// support RTL languages (vercel/satori README + issue #74, no current plan),
// which alone rules out localized og for ar/arz/ur/pnb/fa (the build died on
// "lookupType: 5 - substFormat: 3 is not yet supported" shaping Arabic), and
// non-Latin LTR scripts would each need bundled fonts. One uniform
// default-locale image beats a per-script split; every locale's metadata
// points at the bare-path image and the i18n middleware rewrites it.
export function getPageImage(page: (typeof source)['$inferPage']) {
  const segments = [...page.slugs, 'image.png'];

  return {
    segments,
    url: `${docsImageRoute}/${segments.join('/')}`,
  };
}

export function getPageMarkdownUrl(page: (typeof source)['$inferPage']) {
  const segments = [...page.slugs, 'content.md'];

  return {
    segments,
    url: `${pageRoutePrefix(page)}${docsContentRoute}/${segments.join('/')}`,
  };
}

export async function getLLMText(page: (typeof source)['$inferPage']) {
  const processed = await page.data.getText('processed');

  return `# ${page.data.title} (${page.url})

${processed}`;
}
