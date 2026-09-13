import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import mdx from '@mdx-js/rollup';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';

// Wrap the MDX plugin so ?raw imports fall through to Vite's own raw handler
// and come back as strings rather than components. The copy/download button
// on each page needs the source, not the rendered element.
const mdxPlugin = mdx({
  remarkPlugins: [remarkGfm],
  rehypePlugins: [rehypeHighlight],
}) as Plugin;

const origTransform = mdxPlugin.transform as Function;
mdxPlugin.transform = function (this: unknown, code: string, id: string, ...args: unknown[]) {
  if (id.includes('?')) return undefined;
  return origTransform.call(this, code, id, ...args);
};

export default defineConfig({
  // Project pages live under the repository name. Change this and the two
  // paths in index.html/404.html together if the site ever moves to a domain
  // root -- they are the same value in three places by necessity.
  base: '/ragnarokoffline.app/',
  plugins: [mdxPlugin, react()],
  build: { outDir: 'dist' },
});
