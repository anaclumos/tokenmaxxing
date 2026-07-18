import { RootProvider } from 'fumadocs-ui/provider/next';
import '../global.css';
import { Inter } from 'next/font/google';
import { i18nProvider } from 'fumadocs-ui/i18n';
import { Analytics } from '@vercel/analytics/next';
import { i18n, localeDir } from '@/lib/i18n';
import { translations } from '@/lib/layout.shared';

const inter = Inter({
  subsets: ['latin'],
});

export default async function Layout({ params, children }: LayoutProps<'/[lang]'>) {
  const { lang } = await params;

  return (
    <html
      lang={lang}
      dir={localeDir({ locale: lang })}
      className={inter.className}
      suppressHydrationWarning
    >
      <body className="flex flex-col min-h-screen">
        <RootProvider i18n={i18nProvider(translations, lang)}>{children}</RootProvider>
        <Analytics />
      </body>
    </html>
  );
}

export function generateStaticParams() {
  return i18n.languages.map((lang) => ({ lang }));
}
