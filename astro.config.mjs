// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// https://astro.build/config
export default defineConfig({
  site: 'https://itamarva.github.io',
  base: '/Crypto-Women',
  output: 'static',
  prefetch: {
    prefetchAll: true,
    defaultStrategy: 'hover',
  },
  integrations: [
    sitemap({
      filter: (page) =>
        !page.includes('/thank-you') &&
        !page.includes('טופס') &&
        !page.includes('לפ'),
      i18n: {
        defaultLocale: 'he',
        locales: { he: 'he-IL' },
      },
    }),
  ],
  image: {
    // Use sharp for image optimization
    service: {
      entrypoint: 'astro/assets/services/sharp',
    },
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'i0.wp.com',
      },
      {
        protocol: 'https',
        hostname: 'cryptowomen-il.com',
      },
    ],
  },
  build: {
    inlineStylesheets: 'auto',
  },
  vite: {
    build: {
      cssCodeSplit: true,
      rollupOptions: {
        output: {
          manualChunks: undefined,
        },
      },
    },
  },
});
