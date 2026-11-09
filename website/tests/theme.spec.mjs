import { test, expect } from '@playwright/test';
import { assertFocus, assertRenderedContrast } from './rendered.mjs';

const picker = 'starlight-theme-select select:visible';
const menu = 'starlight-menu-button button';
const search = 'button[data-open-modal]';
async function choose(page, theme, narrow) {
  if (narrow) await page.locator(menu).click();
  await page.locator(picker).selectOption(theme);
  if (narrow) await page.locator(menu).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
}
async function noOverflow(page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth
    <= document.documentElement.clientWidth + 1)).toBe(true);
}
async function ready(page) {
  await page.evaluate(async () => {
    await document.fonts.load('400 16px "DM Sans Variable"');
    await document.fonts.load('600 32px "Space Grotesk Variable"');
    await document.fonts.ready;
  });
  await page.addStyleTag({ content:
    '*,*::before,*::after{animation:none!important;transition:none!important}' });
}

for (const theme of ['light', 'dark']) {
  for (const [width, scale] of [[1280, 1], [360, 1], [360, 2]]) {
    test(`${theme} ${width}px text ${scale * 100}%`, async ({ page }, info) => {
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('response', (response) => {
        if (response.status() >= 400) {
          errors.push(`${response.status()} ${response.url()}`);
        }
      });
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: theme });
      await page.goto('theme/');
      const narrow = width === 360;
      await choose(page, theme, narrow);
      await ready(page);
      if (scale === 2) await page.addStyleTag({ content: 'html{font-size:200%}' });
      const fonts = await page.evaluate(() => ({
        loaded: [...document.fonts].filter((font) => font.status === 'loaded')
          .map((font) => font.family),
        body: getComputedStyle(document.body).fontFamily,
        heading: getComputedStyle(document.querySelector('h1')).fontFamily,
      }));
      expect(fonts.body).toContain('DM Sans Variable');
      expect(fonts.heading).toContain('Space Grotesk Variable');
      expect(fonts.loaded.join(' ')).toContain('DM Sans Variable');
      expect(fonts.loaded.join(' ')).toContain('Space Grotesk Variable');
      await noOverflow(page);
      await expect(page.locator('header')).toBeVisible();
      await expect(page.locator('.expressive-code pre')).toBeVisible();
      expect(await page.locator('.expressive-code pre').evaluate((pre) =>
        ['auto', 'scroll'].includes(getComputedStyle(pre).overflowX))).toBe(true);
      await assertRenderedContrast(page);
      await page.locator('.sl-markdown-content a:not(.sl-anchor-link)').first().hover();
      await assertRenderedContrast(page);
      await assertFocus(page, '.sl-markdown-content a');
      await assertFocus(page, search);
      await page.locator(search).hover();
      await assertRenderedContrast(page);
      if (narrow) {
        await assertFocus(page, menu);
        await page.locator(menu).click();
        await expect(page.locator('#starlight__sidebar')).toBeVisible();
      } else {
        await expect(page.locator('#starlight__sidebar')).toBeVisible();
        await expect(page.locator('starlight-toc')).toBeVisible();
      }
      await assertFocus(page, picker);
      await assertFocus(page, '#starlight__sidebar a[aria-current="page"]');
      await assertRenderedContrast(page);
      if (narrow) {
        await page.keyboard.press('Escape');
        await expect(page.locator(menu)).toBeFocused();
        await expect(page.locator('body'))
          .not.toHaveAttribute('data-mobile-menu-expanded');
      }
      await page.locator(search).focus();
      await page.keyboard.press('Enter');
      await expect(page.locator('dialog')).toBeVisible();
      const input = page.locator('.pagefind-ui__search-input');
      await input.fill('Consumer mapping');
      const result = page.locator('.pagefind-ui__result-link')
        .filter({ hasText: 'Consumer mapping' }).first();
      await expect(result).toBeVisible();
      await assertRenderedContrast(page);
      await result.hover();
      await assertRenderedContrast(page);
      await assertFocus(page, '.pagefind-ui__result-link');
      await assertRenderedContrast(page);
      // Native Tab can briefly leave the document for the browser chrome.
      for (let index = 0; index < 12; index++) {
        await page.keyboard.press('Tab');
        const confined = await page.evaluate(() => {
          const dialog = document.querySelector('dialog:modal');
          return !!dialog && (!document.hasFocus() ||
            dialog.contains(document.activeElement));
        });
        expect(confined).toBe(true);
      }
      await page.keyboard.press('Escape');
      await expect(page.locator('dialog')).not.toBeVisible();
      await expect(page.locator('body')).not.toHaveAttribute('data-search-modal-open');
      await expect(page.locator(search)).toBeFocused();
      await page.keyboard.press('Enter');
      await result.press('Enter');
      await expect(page).toHaveURL(/theme\/#consumer-mapping/);
      await expect(page.locator('dialog')).not.toBeVisible();
      await noOverflow(page);
      await page.screenshot({ path: info.outputPath('theme.png'), fullPage: true,
        animations: 'disabled' });
      await page.reload();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      expect(await page.evaluate(() => localStorage.getItem('starlight-theme')))
        .toBe(theme);
      expect(errors).toEqual([]);
    });
  }
}

test('system preference and explicit overrides', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('theme/');
  await page.locator(picker).selectOption('auto');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await choose(page, 'light', false);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

test('consumer mappings and rendered negative control', async ({ page }) => {
  await page.goto('theme/');
  for (const theme of ['dark', 'light']) {
    await choose(page, theme, false);
    await assertFocus(page, '[data-accent]');
    const mappings = await page.evaluate(() => {
      const expected = (token, property = 'backgroundColor') => {
        const probe = document.createElement('div');
        probe.style[property] = `var(${token})`;
        document.body.append(probe);
        const value = getComputedStyle(probe)[property];
        probe.remove();
        return value;
      };
      const matches = (selector, property, token) => {
        const element = document.querySelector(selector);
        return getComputedStyle(element)[property] === expected(token, property);
      };
      const aliases = {
        background: 'background', foreground: 'text', card: 'surface',
        'card-foreground': 'text', popover: 'surface', 'popover-foreground': 'text',
        primary: 'accent', 'primary-foreground': 'on-accent', secondary: 'surface',
        'secondary-foreground': 'text', muted: 'raised', 'muted-foreground': 'secondary',
        accent: 'accent', 'accent-foreground': 'on-accent', destructive: 'danger',
        'destructive-foreground': 'danger-bg', border: 'border',
        input: 'border', ring: 'focus',
      };
      return [
        matches('body', 'backgroundColor', '--nf-background'),
        matches('body', 'color', '--nf-text'),
        matches('header', 'backgroundColor', '--nf-surface'),
        matches('[data-consumer]', 'backgroundColor', '--nf-background'),
        matches('[data-consumer]', 'color', '--nf-text'),
        matches('[data-consumer]', 'borderTopColor', '--nf-border'),
        matches('[data-accent]', 'backgroundColor', '--nf-accent'),
        matches('[data-accent]', 'color', '--nf-on-accent'),
        matches('[data-accent]', 'outlineColor', '--nf-focus'),
        ...Object.entries(aliases).map(([alias, token]) =>
          expected(`--${alias}`) === expected(`--nf-${token}`)),
      ];
    });
    expect(mappings.every(Boolean)).toBe(true);
    await assertRenderedContrast(page);
  }
  await page.addStyleTag({ content: '.nf-info{color:var(--nf-info-bg)!important}' });
  await expect(assertRenderedContrast(page)).rejects.toThrow(/rendered contrast/);
});
