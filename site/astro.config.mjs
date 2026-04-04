import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://comradeclaw.org',
  markdown: {
    shikiConfig: {
      theme: 'github-light',
    },
  },
});
