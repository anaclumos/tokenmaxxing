import { defineConfig, defineDocs } from 'fumadocs-mdx/config';
import { remarkMermaid } from './lib/remark-mermaid';

export const docs = defineDocs({
  docs: {
    postprocess: {
      includeProcessedMarkdown: true,
    },
  },
});

export default defineConfig({
  mdxOptions: {
    remarkPlugins: [remarkMermaid],
  },
});
