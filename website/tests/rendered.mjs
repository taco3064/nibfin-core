import assert from 'node:assert/strict';
import { rgba, composite, contrast } from '../scripts/contrast.mjs';

// Read actual paints and ancestor opacity, rather than trusting token names.
export async function assertRenderedContrast(page) {
  const samples = await page.evaluate(() => {
    const samples = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const element = node.parentElement;
      if (!node.textContent.trim() || !element
        || element.closest('script, style, .sr-only, [aria-hidden="true"]')) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const visible = [...range.getClientRects()]
        .some((rect) => rect.width && rect.height);
      if (!visible) continue;
      const style = getComputedStyle(element);
      if (style.visibility !== 'visible') continue;
      const layers = [];
      for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
        const paint = getComputedStyle(ancestor);
        layers.push({ background: paint.backgroundColor, opacity: +paint.opacity });
      }
      const large = parseFloat(style.fontSize) >= 24
        || (parseFloat(style.fontSize) >= 18.66 && +style.fontWeight >= 700);
      samples.push({ text: node.textContent.trim().slice(0, 65),
        color: style.color, layers, minimum: large ? 3 : 4.5 });
    }
    return samples;
  });
  assert(samples.length > 15, 'Insufficient rendered text coverage');
  for (const sample of samples) {
    let foreground = rgba(sample.color);
    let background = [0, 0, 0, 0];
    for (const layer of sample.layers) {
      foreground = composite(foreground, rgba(layer.background));
      background = composite(background, rgba(layer.background));
      foreground[3] *= layer.opacity;
      background[3] *= layer.opacity;
    }
    // The themed root is required to provide the opaque final canvas.
    assert.equal(background[3], 1, `Unknown canvas: ${sample.text}`);
    if (foreground[3] === 0) continue;
    const ratio = contrast(foreground, background);
    assert(ratio >= sample.minimum,
      `${sample.text}: rendered contrast ${ratio.toFixed(2)} < ${sample.minimum}`);
  }
}

export async function assertFocus(page, selector) {
  const target = page.locator(selector).filter({ visible: true }).first();
  await target.focus();
  // Tab away and back gives a real keyboard focus-visible state.
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  assert(await target.evaluate((element) => element === document.activeElement),
    `Keyboard focus did not return: ${selector}`);
  const paint = await target.evaluate((element) => {
    const style = getComputedStyle(element);
    const backgrounds = [];
    for (let node = element.parentElement; node; node = node.parentElement) {
      backgrounds.push(getComputedStyle(node).backgroundColor);
    }
    return { color: style.outlineColor, width: parseFloat(style.outlineWidth),
      style: style.outlineStyle, backgrounds };
  });
  assert(paint.width >= 2 && paint.style !== 'none', `Invisible focus: ${selector}`);
  let background = [0, 0, 0, 0];
  for (const value of paint.backgrounds) background = composite(background, rgba(value));
  assert(contrast(rgba(paint.color), background) >= 3,
    `Focus contrast below 3:1: ${selector}`);
}
