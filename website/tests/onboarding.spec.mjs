import { test, expect } from '@playwright/test';
import { assertRenderedContrast, assertFocus } from './rendered.mjs';

for (const theme of ['light', 'dark']) {
  for (const width of [1280, 360]) {
    test(`onboarding ${theme} ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: theme });
      await page.addInitScript(() => {
        window.copied = [];
        Object.defineProperty(navigator, 'clipboard', { configurable: true,
          value: { writeText: async (text) => { window.copied.push(text); } } });
      });
      await page.goto('');
      const start = page.locator('main').getByRole('link',
        { name: 'Getting Started', exact: true }).first();
      await assertFocus(page, 'main a[href$="getting-started/"]');
      await start.press('Enter');
      await expect(page.locator('h1')).toHaveText('Getting Started');
      await expect(page.getByRole('heading', { name: 'Personal repository' }))
        .toBeVisible();
      await expect(page.getByRole('heading', { name: 'Organization repository' }))
        .toBeVisible();
      for (const route of ['installation', 'runners', 'cli']) {
        await page.goto(`${route}/`);
        await expect(page.locator('main')).toContainText('Unverified');
        await assertRenderedContrast(page);
        expect(await page.evaluate(() => document.documentElement.scrollWidth
          <= document.documentElement.clientWidth + 1)).toBe(true);
      }
      const code = page.locator('main pre code');
      await expect(code).toHaveText('node bin/nibfin-core.mjs help');
      await expect(page.locator('main')).toContainText('candidate-only');
      const button = page.locator('main .copy button');
      await button.focus();
      await expect(button).toBeFocused();
      await button.press('Enter');
      await expect.poll(() => page.evaluate(() => window.copied))
        .toEqual(['node bin/nibfin-core.mjs help']);
    });
  }
}
