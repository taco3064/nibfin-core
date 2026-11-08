import { integrationRepairRequired } from './github-ci.mjs';
import { actionsTimeErrors } from './actions-time.mjs';

// Only fixed credential-free diagnostics may cross the public failure boundary.
export function observationFailureCode(error) {
  const code = error?.code;
  return actionsTimeErrors.includes(code) || integrationRepairRequired(code)
    ? code : 'LIVE_OBSERVATION_UNAVAILABLE';
}
