import { defineConfig } from '@playwright/test';

const base = process.env.WEBSITE_BASE;
const output = process.env.NIBFIN_THEME_OUTPUT;
if (!base || !output) throw new Error('Use npm run website:browser from the root.');
export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.mjs',
  outputDir: output,
  workers: 1,
  retries: 0,
  timeout: 60000,
  use: { browserName: 'chromium', headless: true,
    baseURL: `http://127.0.0.1:4330${base}`, reducedMotion: 'reduce' },
  webServer: {
    command: 'npm run website:preview -- --host 127.0.0.1 --port 4330',
    cwd: new URL('../', import.meta.url).pathname,
    url: `http://127.0.0.1:4330${base}`, reuseExistingServer: false,
  },
});
