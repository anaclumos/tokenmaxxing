import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

const config = {
  turbopack: {
    root: import.meta.dirname,
  },
};

export default withMDX(config);
