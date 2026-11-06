import { source } from '@/lib/source';
import { appName, gitConfig } from '@/lib/shared';
import { DocsLayout } from 'fumadocs-ui/layouts/notebook';

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <DocsLayout tree={source.getPageTree()} nav={{ title: appName }} githubUrl={`https://github.com/${gitConfig.user}/${gitConfig.repo}`}>
      {children}
    </DocsLayout>
  );
}
