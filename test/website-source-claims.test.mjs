import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { compareClaim } from '../website/scripts/source-claims.mjs';

const fixture = JSON.parse(await readFile(
  new URL('../website/evidence/source-fixture.json', import.meta.url), 'utf8'));

test('synthetic source control cannot certify real publication', () => {
  const check = (value) => compareClaim(value.claim, value.evidence, { fixture: true });
  check(fixture);
  assert.throws(() => compareClaim(fixture.claim, fixture.evidence), /public read-back/);
  const cases = [
    [(value) => { value.claim.command += ' --invented'; }, /Command\/help/],
    [(value) => { value.evidence.source = null; }, /source unavailable/],
    [(value) => { value.evidence.release.assets = []; }, /asset unavailable/],
    [(value) => { value.claim.version = 'v9'; }, /Version mismatch/],
    [(value) => { value.claim.commit = 'b'.repeat(40); }, /Identity mismatch/],
    [(value) => { value.evidence.release = null; }, /Release unavailable/],
    [(value) => { value.evidence.candidate = true; }, /Candidate/],
    [(value) => { value.evidence.release.tag = 'v2'; }, /Release version/],
    [(value) => { value.evidence.source += 'changed'; }, /Source digest/],
  ];
  for (const [mutate, pattern] of cases) {
    const changed = structuredClone(fixture);
    mutate(changed);
    assert.throws(() => check(changed), pattern);
    check(fixture);
  }
  const unavailable = { ...fixture.claim, status: 'Unverified', command: null };
  compareClaim(unavailable, null);
  assert.throws(() => compareClaim({ ...unavailable, command: 'demo install' }, null),
    /must be withheld/);
  const installed = structuredClone(fixture);
  installed.claim.status = 'Installed';
  assert.throws(() => check(installed), /configuration required/);
  installed.evidence.installation = { commit: installed.claim.commit,
    configuration: 'synthetic configuration only' };
  check(installed);
});
