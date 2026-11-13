import { test, expect } from '@playwright/test';
import { assertFocus, assertRenderedContrast } from './rendered.mjs';

const title = 'Trusted delivery, from Issue to merge';
const destinations = [
  ['getting-started/', 'Getting Started'],
  ['installation/', 'Installation and configuration'],
  ['architecture/', 'Architecture and authority'],
  ['lifecycle/', 'Protected delivery lifecycle'],
  ['security/', 'Security and recovery'],
  ['limitations/', 'Limitations and verification status'],
  ['cli/', 'CLI usage'],
  ['runners/', 'Runner registration and removal'],
  ['project-environment/', 'Project environment'],
];

async function noOverflow(page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth
    <= document.documentElement.clientWidth + 1)).toBe(true);
}

async function tabTo(page, locator) {
  for (let index = 0; index < 35; index++) {
    if (await locator.evaluate((node) => node === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  throw new Error('Principal action not reachable by Tab');
}

for (const theme of ['light', 'dark']) {
  for (const width of [360, 1280]) {
    test(`landing ${theme} ${width}px`, async ({ page, context }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: theme });
      await page.goto('');
      await expect(page.locator('h1')).toHaveText(title);
      await expect(page.locator('main')).toContainText('Public Repository');
      await expect(page.locator('main')).toContainText('Unverified: formal');
      await noOverflow(page);
      expect(await page.locator('body').evaluate((node) =>
        getComputedStyle(node).fontFamily)).toContain('DM Sans Variable');
      expect(await page.locator('h1').evaluate((node) =>
        getComputedStyle(node).fontFamily)).toContain('Space Grotesk Variable');
      await assertRenderedContrast(page);
      const skip = page.getByRole('link', { name: 'Skip to content' });
      await page.keyboard.press('Tab');
      await expect(skip).toBeFocused();
      await page.keyboard.press('Enter');
      const actions = page.locator('.hero .actions a');
      await expect(actions).toHaveCount(2);
      await expect(actions.first()).toHaveClass(/\bbg-primary\b/);
      await expect(actions.last()).toHaveClass(/\bborder-border\b/);
      const steps = page.locator('.nf-delivery-steps > li');
      await expect(steps).toHaveCount(3);
      await expect(steps.first()).toHaveCSS('border-left-width', '0px');
      await expect(steps.first()).toHaveCSS('border-top-width', '1px');
      const boxes = [];
      for (const action of await actions.all()) {
        await tabTo(page, action);
        await expect(action).toBeFocused();
        await assertFocus(page, `.hero a[href="${await action.getAttribute('href')}"]`);
        const box = await action.boundingBox();
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(width);
        boxes.push(box);
        await action.hover();
        await assertRenderedContrast(page);
      }
      const [a, b] = boxes;
      expect(a.x + a.width <= b.x || b.x + b.width <= a.x
        || a.y + a.height <= b.y || b.y + b.height <= a.y).toBe(true);
      // Follow both principal actions with Enter, not synthetic route requests.
      for (let index = 0; index < 2; index++) {
        await page.goto('');
        const action = page.locator('.hero .actions a').nth(index);
        await tabTo(page, action);
        await action.press('Enter');
        await expect(page.locator('h1')).toHaveText(destinations[index][1]);
      }
      for (const [route, heading] of destinations) {
        await page.goto('');
        await page.locator(`main a[href$="${route}"]`).first().click();
        await expect(page.locator('h1')).toHaveText(heading);
      }
      for (const [route, fragment] of [
        ['lifecycle/', 'from-scope-to-closure'],
        ['installation/', 'component-status'],
      ]) {
        await page.goto('');
        await page.locator(`main a[href$="${route}#${fragment}"]`).click();
        await expect(page).toHaveURL(new RegExp(`${route}#${fragment}$`));
        await expect(page.locator(`#${fragment}`)).toBeVisible();
      }
      await page.goto('');
      const picker = page.locator('starlight-theme-select select:visible');
      const opposite = theme === 'light' ? 'dark' : 'light';
      await picker.selectOption(opposite);
      await expect(page.locator('html')).toHaveAttribute('data-theme', opposite);
      await picker.selectOption(theme);
      await page.locator('.hero .actions a').first().click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      const fresh = await context.newPage();
      await fresh.goto('');
      await expect(fresh.locator('html')).toHaveAttribute('data-theme', theme);
      await fresh.close();
      await page.goto('');
      await page.reload();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    });

    test(`static landing ${theme} ${width}px`, async ({ browser, baseURL }) => {
      const context = await browser.newContext({ javaScriptEnabled: false,
        viewport: { width, height: 900 }, colorScheme: theme, baseURL });
      try {
        const page = await context.newPage();
        await page.goto('');
        await expect(page.locator('h1')).toHaveText(title);
        await noOverflow(page);
        for (const [route, heading] of destinations) {
          await page.goto('');
          await page.locator(`main a[href$="${route}"]`).first().click();
          await expect(page.locator('h1')).toHaveText(heading);
        }
      } finally {
        await context.close();
      }
    });
  }
}
