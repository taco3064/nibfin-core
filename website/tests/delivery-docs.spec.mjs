import { test, expect } from '@playwright/test';
import { assertFocus, assertRenderedContrast } from './rendered.mjs';

const routes = ['architecture', 'lifecycle', 'security', 'limitations'];
for (const theme of ['light', 'dark']) {
  for (const width of [1280, 360]) {
    test(`delivery documents ${theme} ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: theme });
      for (const route of routes) {
        await page.goto(`${route}/`);
        await expect(page.locator('h1')).toBeVisible();
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        expect(await page.evaluate(() => document.documentElement.scrollWidth
          <= document.documentElement.clientWidth + 1)).toBe(true);
        await assertRenderedContrast(page);
        if (width === 360) {
          await page.locator('starlight-menu-button button').click();
        }
        const link = `#starlight__sidebar a[href$="/${route}/"]`;
        await assertFocus(page, link);
        await page.keyboard.press('Enter');
        await expect(page).toHaveURL(new RegExp(`/${route}/$`));
      }
    });
  }
}

test('delivery content is searchable', async ({ page }) => {
  await page.goto('');
  await page.locator('button[data-open-modal]').click();
  await page.locator('.pagefind-ui__search-input').fill('reconciled');
  const result = page.locator('.pagefind-ui__result-link[href*="/security/"]').first();
  await expect(result).toBeVisible();
  await result.click();
  await expect(page).toHaveURL(/security\//);
});
