import Link from 'next/link';
import { enHomeCopy, homeCopy } from '@/lib/home-copy';
import { localePath } from '@/lib/i18n';

export default async function HomePage({ params }: PageProps<'/[lang]'>) {
  const { lang } = await params;
  const copy = homeCopy[lang] ?? enHomeCopy;

  return (
    <div className="flex flex-col justify-center text-center flex-1">
      <h1 className="text-2xl font-bold mb-4">tokenmaxxing</h1>
      <p>
        {copy.beforeLink}
        <Link href={localePath({ locale: lang, path: '/docs' })} className="font-medium underline">
          {copy.linkLabel}
        </Link>
        {copy.afterLink}
      </p>
    </div>
  );
}
