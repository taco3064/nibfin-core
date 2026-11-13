import { test, expect } from '@playwright/test';
import { assertFocus, assertRenderedContrast } from './rendered.mjs';

const button = '[data-copy-example] button';
const status = '[data-copy-example] [role="status"]';
const sample = '[data-reading-example] pre';

async function clipboard(page, mode = 'success') {
  await page.addInitScript((mode) => {
    window.copyWrites = [];
    window.copyMode = mode;
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText(text) {
        window.copyWrites.push(text);
        if (window.copyMode === 'reject') return Promise.reject(new Error('denied'));
        if (window.copyMode === 'defer') return new Promise((resolve, reject) => {
          window.finishCopy = resolve;
          window.rejectCopy = () => reject(new Error('denied'));
        });
        return Promise.resolve();
      },
    } });
  }, mode);
}
async function load(page) {
  await page.goto('theme/');
  await expect(page.locator(button)).toBeEnabled();
}
async function copied(page) {
  await expect(page.locator(status)).toHaveText('Example copied.');
  expect(await page.evaluate(() => window.copyWrites))
    .toEqual([await page.locator(sample).innerText()]);
}

test('copy the actual displayed example with keyboard activation', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await clipboard(page);
  await load(page);
  await expect(page.getByText('not an installation command.', { exact: false }))
    .toBeVisible();
  // Tab through the real document to the actual native button.
  for (let i = 0; i < 100; i++) {
    await page.keyboard.press('Tab');
    if (await page.locator(button).evaluate((node) => node === document.activeElement)) {
      break;
    }
  }
  await expect(page.locator(button)).toBeFocused();
  await expect(page.locator(button)).toHaveAccessibleName('Copy reading example');
  await assertFocus(page, button);
  await page.keyboard.press('Enter');
  await copied(page);
  await expect(page.locator(button)).toBeFocused();
  await page.keyboard.press('Space');
  await expect.poll(() => page.evaluate(() => window.copyWrites.length)).toBe(2);
  expect(await page.evaluate(() => window.copyWrites[0] === window.copyWrites[1]))
    .toBe(true);
  expect(errors).toEqual([]);
});

test('absent and denied clipboard remain readable and allow retry', async ({ page }) => {
  await clipboard(page, 'reject');
  await load(page);
  await page.locator(button).click();
  await expect(page.locator(status)).toContainText('Unable to copy.');
  await expect(page.locator(sample)).toBeVisible();
  expect(await page.locator(sample).evaluate((node) =>
    getComputedStyle(node).userSelect)).not.toBe('none');
  await page.evaluate(() => {
    window.savedClipboard = navigator.clipboard;
    Object.defineProperty(navigator, 'clipboard', { configurable: true,
      value: undefined });
  });
  await page.locator(button).click();
  await expect(page.locator(status)).toContainText('copy it manually. Try again.');
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true,
      value: window.savedClipboard });
    window.copyMode = 'success';
    window.copyWrites = [];
  });
  await page.locator(button).click();
  await copied(page);
});

test('deferred writes cannot announce early success or overlap', async ({ page }) => {
  await clipboard(page, 'defer');
  await load(page);
  await page.locator(button).click();
  await expect(page.locator(status)).toHaveText('Copying example…');
  await page.locator(button).focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Space');
  expect(await page.evaluate(() => window.copyWrites.length)).toBe(1);
  await expect(page.locator(status)).toHaveText('Copying example…');
  await page.evaluate(() => window.rejectCopy());
  await expect(page.locator(status)).toContainText('Unable to copy.');
  await page.locator(button).press('Enter');
  await expect(page.locator(status)).toHaveText('Copying example…');
  await page.evaluate(() => window.finishCopy());
  await expect(page.locator(status)).toHaveText('Example copied.');
  await expect(page.locator(button)).toBeFocused();
});

test('static reading works without JavaScript', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  try {
    const page = await context.newPage();
    await page.goto(baseURL + 'theme/');
    await expect(page.locator(sample)).toContainText('console.log(message);');
    await expect(page.locator(button)).toBeDisabled();
    await expect(page.locator('[data-manual-copy]')).toBeVisible();
    await expect(page.locator('h1')).toHaveText('Theme reading sample');
    await page.getByRole('link', { name: 'internal link', exact: true }).click();
    await expect(page).toHaveURL(baseURL);
  } finally {
    await context.close();
  }
});

async function assertIslandMapping(page, hover = false) {
  const matches = await page.locator(button).evaluate((node, hover) => {
    const paint = getComputedStyle(node);
    const probe = document.createElement('div');
    probe.style.backgroundColor = hover ? 'var(--nf-hover)' : 'var(--nf-accent)';
    probe.style.color = 'var(--nf-on-accent)';
    probe.style.outlineColor = 'var(--nf-focus)';
    probe.style.borderColor = 'var(--nf-border-subtle)';
    document.body.append(probe);
    const expected = getComputedStyle(probe);
    const result = ['backgroundColor', 'color', 'outlineColor', 'borderTopColor']
      .every((key) => paint[key] === expected[key]);
    probe.remove();
    return result;
  }, hover);
  expect(matches, 'React utility semantic mapping').toBe(true);
}

for (const theme of ['light', 'dark']) {
  for (const [width, scale] of [[1280, 1], [360, 1], [360, 2]]) {
    test(`island ${theme} ${width}px ${scale * 100}%`, async ({ page }) => {
      await clipboard(page, 'defer');
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: theme });
      await load(page);
      if (scale === 2) {
        await page.addStyleTag({ content: 'html{font-size:200%}' });
      }
      await assertFocus(page, button);
      await assertIslandMapping(page);
      await assertRenderedContrast(page);
      await page.locator(button).hover();
      await assertIslandMapping(page, true);
      await assertRenderedContrast(page);
      await page.locator(button).click();
      await expect(page.locator(status)).toHaveText('Copying example…');
      await assertRenderedContrast(page);
      // Keep the island identity and pending state across a real theme change.
      await page.locator(button).evaluate((node) => { window.originalButton = node; });
      await page.emulateMedia({ colorScheme: theme === 'dark' ? 'light' : 'dark' });
      await expect(page.locator('html')).toHaveAttribute('data-theme',
        theme === 'dark' ? 'light' : 'dark');
      const same = await page.locator(button).evaluate((node) =>
        node === window.originalButton);
      expect(same).toBe(true);
      await expect(page.locator(status)).toHaveText('Copying example…');
      await page.evaluate(() => window.rejectCopy());
      await expect(page.locator(status)).toContainText('Unable to copy.');
      await assertRenderedContrast(page);
      await page.evaluate(() => { window.copyMode = 'success'; });
      await page.locator(button).click();
      await expect(page.locator(status)).toHaveText('Example copied.');
      await assertRenderedContrast(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth
        <= document.documentElement.clientWidth + 1)).toBe(true);
    });
  }
}

test('broken React mapping and low contrast are detected', async ({ page }) => {
  await clipboard(page);
  await load(page);
  await assertFocus(page, button);
  await assertIslandMapping(page);
  const broken = await page.addStyleTag({ content:
    '[data-copy-example] button{background:var(--nf-background)!important}' });
  await expect(assertIslandMapping(page)).rejects.toThrow(/semantic mapping/);
  await broken.evaluate((node) => node.remove());
  await assertIslandMapping(page);
  await page.addStyleTag({ content:
    '[data-copy-example] button{color:var(--nf-accent)!important}' });
  await expect(assertRenderedContrast(page)).rejects.toThrow(/rendered contrast/);
});
