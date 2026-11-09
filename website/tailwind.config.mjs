import { fileURLToPath } from 'node:url';

const names = [
  'background', 'foreground', 'card', 'popover', 'primary', 'secondary',
  'muted', 'accent', 'destructive', 'border', 'input', 'ring',
];
const paired = new Set([
  'card', 'popover', 'primary', 'secondary', 'muted', 'accent', 'destructive',
]);
export default {
  content: [fileURLToPath(new URL('./src/**/*.{astro,md,mdx,ts,tsx}', import.meta.url))],
  corePlugins: { preflight: false },
  theme: {
    colors: Object.fromEntries(names.map((name) => [name, paired.has(name)
      ? { DEFAULT: `var(--${name})`, foreground: `var(--${name}-foreground)` }
      : `var(--${name})`])),
  },
};
