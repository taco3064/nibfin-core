import { integrationRepairRequired } from './github-ci.mjs';
import { actionsTimeErrors } from './actions-time.mjs';

const hostPreflightCodes = new Set([
  'AGENT_IMAGE_UNAVAILABLE',
  'AGENT_EGRESS_NOT_ISOLATED',
  'DOCKER_ISOLATION_UNAVAILABLE',
  'DOCKER_BACKEND_NOT_ENFORCED',
  'SANDBOX_IMAGE_UNAVAILABLE',
  'UNTRUSTED_DOCKER_SOCKET',
  'UNTRUSTED_ROOTFUL_DOCKER_SOCKET',
]);

// Only fixed credential-free diagnostics may cross the public failure boundary.
export function observationFailureCode(error) {
  const code = error?.code;
  if (error?.name === 'TimeoutError') return 'LIVE_OBSERVATION_TIMEOUT';
  if (Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599)
    return `LIVE_OBSERVATION_HTTP_${error.status}`;
  return hostPreflightCodes.has(code) || actionsTimeErrors.includes(code) ||
    integrationRepairRequired(code)
    ? code : 'LIVE_OBSERVATION_UNAVAILABLE';
}
