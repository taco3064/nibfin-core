import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import starlight from '@astrojs/starlight';
import tailwind from 'tailwindcss';
import theme from './tailwind.config.mjs';
import { sidebar } from './navigation.mjs';
import { checkNavigation } from './scripts/navigation.mjs';

const site = process.env.WEBSITE_SITE || 'https://taco3064.github.io';
const base = process.env.WEBSITE_BASE || '/nibfin-core/';
const origin = new URL(site);
if (origin.origin !== site.replace(/\/$/, '') || !/^https?:$/.test(origin.protocol)) {
  throw new Error('WEBSITE_SITE must be an HTTP(S) origin without a path.');
}
if (!/^\/(?:[A-Za-z0-9_-]+\/)*$/.test(base)) {
  throw new Error('WEBSITE_BASE must start and end with / and contain path segments.');
}

export default defineConfig({
  site,
  base,
  output: 'static',
  vite: { css: { postcss: { plugins: [tailwind(theme)] } } },
  trailingSlash: 'always',
  integrations: [
    react(),
    starlight({
      title: 'Nibfin documentation',
      logo: {
        src: './src/assets/nibfin-logo.png',
        replacesTitle: true,
      },
      favicon: '/favicon.png',
      head: [
        {
          tag: 'link',
          attrs: { rel: 'apple-touch-icon', href: `${base}apple-touch-icon.png` },
        },
      ],
      locales: { root: { label: 'English', lang: 'en' } },
      sidebar,
      components: { Hero: './src/components/HomeHero.astro' },
      customCss: ['./src/styles/theme.css'],
    }),
    {
      name: 'validate-documentation-navigation',
      hooks: {
        'astro:build:done': ({ pages }) => checkNavigation(sidebar, pages),
      },
    },
  ],
});
