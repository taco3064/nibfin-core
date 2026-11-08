import test from 'node:test';
import assert from 'node:assert/strict';
import { validateActionsTime } from '../src/actions-time.mjs';
import { observationFailureCode } from '../src/observation-failure.mjs';

test('signed time constraints remain strict and expose only a bounded denial', () => {
  const now = 1000000;
  const valid = { iat: 990, nbf: 990, exp: 1200, jti: 'synthetic-private-id' };
  assert.doesNotThrow(() => validateActionsTime(valid, now));
  assert.doesNotThrow(() => validateActionsTime({ ...valid, iat: 1002 }, now));
  for (const [change, code] of [
    [{ iat: '990' }, 'OIDC_TIME_INVALID'],
    [{ exp: 2000 }, 'OIDC_LIFETIME_INVALID'],
    [{ iat: 1201 }, 'OIDC_LIFETIME_INVALID'],
    [{ nbf: 1001 }, 'OIDC_NOT_YET_ACTIVE'],
    [{ exp: 1000 }, 'OIDC_EXPIRED'],
    [{ jti: '' }, 'OIDC_ID_MISSING'],
  ]) {
    assert.throws(() => validateActionsTime({ ...valid, ...change }, now), error => {
      assert.equal(error.message, code);
      assert.equal(observationFailureCode(error), code);
      assert.equal(error.message.includes(valid.jti), false);
      return true;
    });
  }
  for (const instant of [NaN, Infinity, '1000000'])
    assert.throws(() => validateActionsTime(valid, instant),
      { code: 'OIDC_TIME_INVALID' });
  assert.equal(observationFailureCode({ code: 'PRIVATE_SECRET',
    message: valid.jti }), 'LIVE_OBSERVATION_UNAVAILABLE');
  assert.equal(observationFailureCode(null), 'LIVE_OBSERVATION_UNAVAILABLE');
});
