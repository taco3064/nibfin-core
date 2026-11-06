import { actionsTimeErrors } from './actions-time.mjs';

// Only fixed credential-free diagnostics may cross the public failure boundary.
export function observationFailureCode(error) {
  return actionsTimeErrors.includes(error?.code)
    ? error.code : 'LIVE_OBSERVATION_UNAVAILABLE';
}
