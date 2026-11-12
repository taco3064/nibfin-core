import { integrationRepairRequired } from './github-ci.mjs';
import { actionsTimeErrors } from './actions-time.mjs';
import { transientGitHubRead } from './github-read-retry.mjs';
import { setTimeout } from 'node:timers/promises';

const hostPreflightCodes = new Set([
  'AGENT_IMAGE_UNAVAILABLE',
  'AGENT_EGRESS_NOT_ISOLATED',
  'DOCKER_ISOLATION_UNAVAILABLE',
  'DOCKER_BACKEND_NOT_ENFORCED',
  'SANDBOX_IMAGE_UNAVAILABLE',
  'UNTRUSTED_DOCKER_SOCKET',
  'UNTRUSTED_ROOTFUL_DOCKER_SOCKET',
  'WORKSPACE_ADOPTION_UNRESOLVED',
]);

export const githubReadWaiting = 'GITHUB_READ_RETRY_PENDING';
export const githubReadDelay = (retryAfterMs, attempt) =>
  Math.max(retryAfterMs ?? 0, Math.min(60000, 5000 * 2 ** attempt));

export function githubReadWait(error, now = Date.now()) {
  if (!transientGitHubRead(error)) return null;
  const digits = value => /^\d{1,12}$/.test(value ?? '') ? Number(value) : 0;
  const retryAfterMs = Math.max(
    [403, 429].includes(error.status) ? 60000 : 0,
    digits(error.retryAfter) * 1000,
    digits(error.rateLimitReset) * 1000 - now + 1000,
  );
  const resource = /^\/[-A-Za-z0-9_./]+$/.test(error.resource ?? '')
    ? error.resource : 'GitHub';
  const request = /^[A-Fa-f0-9:]{1,80}$/.test(error.requestId ?? '')
    ? ` (request ${error.requestId})` : '';
  const status = Number.isInteger(error.status) ? error.status : 'network';
  console.error(`GitHub read waiting: ${resource} ${status}${request}`);
  return { status: 'pending', code: githubReadWaiting, retryAfterMs };
}

// Use only for observations whose callback cannot perform an external write.
export async function retryGitHubObservation(observe, {
  wait = setTimeout, clock = Date.now, timeout = 600000,
} = {}) {
  const deadline = clock() + timeout;
  for (let attempt = 0; ; attempt++) {
    try {
      return await observe();
    } catch (error) {
      const waiting = githubReadWait(error, clock());
      if (!waiting) throw error;
      const delay = githubReadDelay(waiting.retryAfterMs, attempt);
      if (clock() + delay > deadline) throw error;
      await wait(delay);
    }
  }
}

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
