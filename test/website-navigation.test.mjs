import assert from 'node:assert/strict';
import test from 'node:test';
import { checkNavigation } from '../website/scripts/navigation.mjs';

test('validates nested sidebar slugs against generated pages', () => {
  checkNavigation([
    { label: 'Home', slug: 'index' },
    { label: 'Guides', items: ['guides/start', { slug: 'guides/index' }] },
  ], [{ pathname: '' }, { pathname: 'guides/start/' }, { pathname: 'guides/' }]);
});

test('rejects nonexistent navigation targets with an actionable error', () => {
  assert.throws(
    () => checkNavigation([{ slug: 'missing' }], [{ pathname: '' }]),
    /Navigation target has no generated documentation route: missing/,
  );
});

test('requires base-aware Starlight slugs for internal links', () => {
  assert.throws(
    () => checkNavigation([{ link: '/guide/' }], [{ pathname: 'guide/' }]),
    /Use a Starlight content slug/,
  );
  checkNavigation([{ link: 'https://example.org/' }], []);
});
