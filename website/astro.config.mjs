import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';

// https://astro.build/config
export default defineConfig({
  site: 'https://julianrico.github.io/vibetranslate',
  integrations: [
    tailwind({
      applyBaseStyles: false,
    }),
  ],
  build: {
    format: 'directory',
  },
  vite: {
    server: {
      allowedHosts: true,
    },
  },
});
