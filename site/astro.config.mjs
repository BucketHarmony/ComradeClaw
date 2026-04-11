import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://bucketharmony.github.io',
  base: '/ComradeClaw',
  markdown: {
    shikiConfig: {
      theme: 'github-light',
    },
  },
});
