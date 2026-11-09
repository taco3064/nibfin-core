import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import postcss from 'postcss';
import tailwind from 'tailwindcss';
import { requireContrast } from './contrast.mjs';

export const requiredTokens = [
  'background', 'surface', 'raised', 'text', 'secondary', 'border', 'link',
  'accent', 'on-accent', 'hover', 'focus', 'info', 'info-bg', 'success',
  'success-bg', 'warning', 'warning-bg', 'danger', 'danger-bg', 'code', 'code-bg',
];
export const pairs = [
  ['text', 'background'], ['text', 'surface'], ['secondary', 'raised'],
  ['link', 'background'], ['hover', 'background'], ['on-accent', 'accent'],
  ['on-accent', 'hover'], ['code', 'code-bg'], ['info', 'info-bg'],
  ['success', 'success-bg'], ['warning', 'warning-bg'], ['danger', 'danger-bg'],
];
export async function checkTheme(directory = 'website') {
  const load = (path) => readFile(resolve(directory, path), 'utf8');
  const tokens = postcss.parse(await load('src/styles/tokens.css'));
  const theme = postcss.parse(await load('src/styles/theme.css'));
  const aliases = new Map();
  theme.walkDecls(/^--/, (declaration) => {
    aliases.set(declaration.prop, declaration.value);
    assert(!/#[\da-f]{3,8}\b|\b(?:rgb|hsl)a?\(/i.test(declaration.value),
      `Color outside token source: ${declaration.prop}`);
  });
  const namedAliases = [
    'background', 'foreground', 'card', 'card-foreground', 'popover',
    'popover-foreground', 'primary', 'primary-foreground', 'secondary',
    'secondary-foreground', 'muted', 'muted-foreground', 'accent',
    'accent-foreground', 'destructive', 'destructive-foreground', 'border',
    'input', 'ring', 'sl-color-bg', 'sl-color-text', 'sl-color-bg-nav',
    'sl-color-bg-sidebar', 'sl-color-text-accent', 'sl-color-bg-inline-code',
  ];
  for (const alias of namedAliases) {
    assert(aliases.has('--' + alias), 'Missing documented alias: ' + alias);
  }
  const config = (await import(pathToFileURL(resolve(directory,
    'tailwind.config.mjs')))).default;
  for (const selector of [':root', ":root[data-theme='light']"]) {
    const values = new Map(aliases);
    const rule = tokens.nodes.find((node) => node.selector === selector);
    assert(rule, `Missing theme: ${selector}`);
    rule.walkDecls((decl) => values.set(decl.prop, decl.value));
    for (const name of requiredTokens) {
      assert(rule.nodes.some((decl) => decl.prop === `--nf-${name}`),
        `Missing token: --nf-${name} in ${selector}`);
    }
    const resolveValue = (name, seen = new Set()) => {
      assert(!seen.has(name), `Alias cycle: ${name}`);
      assert(values.has(name), `Missing alias: ${name}`);
      seen.add(name);
      return values.get(name).replace(/var\((--[\w-]+)\)/g,
        (_, reference) => resolveValue(reference, new Set(seen)));
    };
    for (const name of values.keys()) resolveValue(name);
    for (const [fg, bg] of pairs) {
      requireContrast(resolveValue(`--nf-${fg}`), resolveValue(`--nf-${bg}`),
        4.5, `${selector}: ${fg}/${bg}`);
    }
    for (const bg of ['background', 'surface', 'raised']) {
      for (const fg of ['focus', 'border']) {
        requireContrast(resolveValue(`--nf-${fg}`), resolveValue(`--nf-${bg}`),
          3, `${selector}: ${fg}/${bg}`);
      }
    }
    const utilities = {
      'bg-background': ['background-color', '--nf-background'],
      'text-foreground': ['color', '--nf-text'],
      'border-border': ['border-color', '--nf-border'],
      'bg-primary': ['background-color', '--nf-accent'],
      'text-primary-foreground': ['color', '--nf-on-accent'],
      'outline-ring': ['outline-color', '--nf-focus'],
    };
    const output = await postcss([tailwind({ ...config,
      content: [{ raw: Object.keys(utilities).join(' ') }],
    })]).process('@tailwind utilities;', { from: undefined });
    for (const [name, [property, target]] of Object.entries(utilities)) {
      let value;
      output.root.walkRules(`.${name}`, (rule) => rule.walkDecls(property,
        (declaration) => { value = declaration.value; }));
      assert(value, `Missing utility: ${name}`);
      const resolved = value.replace(/var\((--[\w-]+)\)/g,
        (_, reference) => resolveValue(reference));
      assert.equal(resolved, resolveValue(target), `Broken mapping: ${name}`);
    }
  }
  const path = resolve(directory, 'src/styles/theme.css');
  const fonts = [];
  theme.walkAtRules('font-face', (rule) => rule.walkDecls('src', (decl) => {
    fonts.push(decl.value.match(/url\(['"]?([^)'"\s]+)/)?.[1]);
  }));
  assert.equal(fonts.length, 2, 'Both bundled fonts are required');
  for (const font of fonts) {
    assert(font, 'Invalid font URL');
    const bytes = await readFile(resolve(dirname(path), font));
    assert.equal(bytes.subarray(0, 4).toString(), 'wOF2', `Invalid font: ${font}`);
  }
  console.log('Both token themes, aliases, utility mappings, contrast and fonts passed.');
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await checkTheme(process.argv[2]);
}
