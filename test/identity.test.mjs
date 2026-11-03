import test from 'node:test';
import assert from 'node:assert/strict';
import { canonical, digest, gitBlob } from '../src/identity.mjs';

test('canonical identity sorts object keys and preserves exact array and Scope text order', () => {
  assert.equal(digest({ b: 2, a: [1, 2] }), digest({ a: [1, 2], b: 2 }));
  assert.notEqual(digest([1, 2]), digest([2, 1]));
  assert.notEqual(digest('Scope\n'), digest('Scope'));
  assert.equal(gitBlob('hello\n'), 'ce013625030ba8dba906f756967f9e9ca394464a');
  assert.equal(canonical([null, true, 1, 'a']), '[null,true,1,"a"]');
});

test('ambiguous, executable and lossy evidence values reject without invoking accessors', () => {
  let accessed = false;
  const getter = Object.defineProperty({}, 'x', { enumerable: true, get() { accessed = true; return 1; } });
  const cyclic = {}; cyclic.self = cyclic;
  const extra = []; extra.x = 1;
  for (const value of [undefined, NaN, Infinity, 1n, new Date(), { x: undefined }, Array(1), extra,
    cyclic, getter, { [Symbol('x')]: 1 }, Object.defineProperty({}, 'hidden', { value: 1 })]) {
    assert.throws(() => digest(value));
  }
  assert.equal(accessed, false);
});
