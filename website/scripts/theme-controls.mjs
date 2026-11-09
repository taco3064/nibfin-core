import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkTheme } from './theme-source.mjs';
import { requireContrast } from './contrast.mjs';

const copy = await mkdtemp(join(tmpdir(), 'nibfin-theme-'));
try {
  for (const path of ['src/styles', 'src/assets', 'tailwind.config.mjs']) {
    await cp(join('website', path), join(copy, path), { recursive: true });
  }
  await checkTheme(copy);
  const tokens = join(copy, 'src/styles/tokens.css');
  const source = await readFile(tokens, 'utf8');
  await writeFile(tokens, source.replace(/  --nf-text:.*\n/, ''));
  await assert.rejects(checkTheme(copy), /Missing token: --nf-text/);
  await writeFile(tokens, source);
  const theme = join(copy, 'src/styles/theme.css');
  const css = await readFile(theme, 'utf8');
  await writeFile(theme, css.replace('--primary: var(--nf-accent)',
    '--primary: var(--nf-missing)'));
  await assert.rejects(checkTheme(copy), /Missing alias: --nf-missing/);
  await writeFile(theme, css.replace('--primary: var(--nf-accent)',
    '--primary: var(--nf-background)'));
  await assert.rejects(checkTheme(copy), /Broken mapping: bg-primary/);
  await writeFile(theme, css.replace('--primary: var(--nf-accent)',
    '--primary: var(--primary)'));
  await assert.rejects(checkTheme(copy), /Alias cycle: --primary/);
  await writeFile(theme, css);
  const font = join(copy, 'src/assets/fonts/dm-sans-latin-wght-normal.woff2');
  const bytes = await readFile(font);
  await rm(font);
  await assert.rejects(checkTheme(copy), /ENOENT/);
  await writeFile(font, bytes);
  assert.throws(() => requireContrast('#eeeeee', '#ffffff', 4.5,
    'Low-contrast negative control'), /Low-contrast negative control/);
  await checkTheme(copy);
  console.log('Token, alias, mapping, font and contrast negative controls passed.');
} finally {
  await rm(copy, { recursive: true, force: true });
}
