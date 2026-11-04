import { createPublicKey, verify } from 'node:crypto';
import { digest, isId, isSha, requireThat } from './identity.mjs';

const issuer = 'https://token.actions.githubusercontent.com';
function decode(part) {
  requireThat(
    typeof part === 'string' && /^[A-Za-z0-9_-]+$/.test(part),
    'INVALID_OIDC_ENCODING',
  );
  const bytes = Buffer.from(part, 'base64url');
  requireThat(bytes.toString('base64url') === part, 'NONCANONICAL_OIDC_ENCODING');
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

// GitHub's own signing keys establish caller provenance; no Nibfin signing key,
// new identity provider or hosted authorization service is introduced.
export async function verifyActionsIdentity(
  token,
  expected,
  { fetcher = fetch, now = Date.now() } = {},
) {
  requireThat(
    typeof token === 'string' &&
      token.length <= 32768 &&
      token.split('.').length === 3 &&
      ['repositoryId', 'ownerId', 'runId', 'attempt', 'actorId', 'checkRunId'].every(
        (key) => isId(expected?.[key]),
      ) &&
      isSha(expected.sourceCommit) &&
      typeof expected.audience === 'string' &&
      expected.audience.startsWith('nibfin:') &&
      typeof expected.subject === 'string' &&
      expected.subject &&
      typeof expected.workflowRef === 'string',
    'INVALID_CALLER_PIN',
  );
  const [headerPart, payloadPart, signaturePart] = token.split('.'),
    header = decode(headerPart),
    payload = decode(payloadPart);
  requireThat(
    header.alg === 'RS256' &&
      header.typ === 'JWT' &&
      typeof header.kid === 'string' &&
      header.kid &&
      !header.crit &&
      !header.jku &&
      !header.jwk &&
      !header.x5u &&
      /^[A-Za-z0-9_-]+$/.test(signaturePart),
    'UNTRUSTED_OIDC_HEADER',
  );
  const get = async (url) => {
    const response = await fetcher(url, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
    requireThat(response.ok, 'GITHUB_OIDC_KEYS_UNAVAILABLE');
    const text = await response.text();
    requireThat(Buffer.byteLength(text) <= 256 * 1024, 'OIDC_METADATA_TOO_LARGE');
    return JSON.parse(text);
  };
  const metadata = await get(`${issuer}/.well-known/openid-configuration`);
  requireThat(
    metadata.issuer === issuer && metadata.jwks_uri === `${issuer}/.well-known/jwks`,
    'OIDC_ISSUER_METADATA_CHANGED',
  );
  const keys = await get(metadata.jwks_uri);
  requireThat(Array.isArray(keys.keys) && keys.keys.length <= 20, 'INVALID_OIDC_KEY_SET');
  const matches = keys.keys.filter(
    (key) =>
      key.kid === header.kid &&
      key.kty === 'RSA' &&
      key.use === 'sig' &&
      key.alg === 'RS256',
  );
  requireThat(matches.length === 1 && !matches[0].d, 'OIDC_KEY_NOT_UNIQUE');
  const key = createPublicKey({ key: matches[0], format: 'jwk' });
  requireThat(
    key.asymmetricKeyDetails?.modulusLength >= 2048 &&
      verify(
        'RSA-SHA256',
        Buffer.from(`${headerPart}.${payloadPart}`),
        key,
        Buffer.from(signaturePart, 'base64url'),
      ),
    'OIDC_SIGNATURE_INVALID',
  );
  const seconds = Math.floor(now / 1000);
  requireThat(
    [payload.iat, payload.nbf, payload.exp].every(Number.isSafeInteger) &&
      payload.iat <= seconds &&
      payload.nbf <= seconds &&
      seconds < payload.exp &&
      payload.iat <= payload.exp &&
      payload.exp - payload.iat <= 600 &&
      typeof payload.jti === 'string' &&
      payload.jti,
    'OIDC_EXPIRED_OR_INACTIVE',
  );
  requireThat(
    payload.iss === issuer &&
      payload.aud === expected.audience &&
      payload.sub === expected.subject &&
      payload.repository === expected.repository &&
      payload.repository_id === String(expected.repositoryId) &&
      payload.repository_owner_id === String(expected.ownerId) &&
      payload.repository_visibility === 'public' &&
      payload.run_id === String(expected.runId) &&
      payload.run_attempt === String(expected.attempt) &&
      payload.actor_id === String(expected.actorId) &&
      payload.check_run_id === String(expected.checkRunId) &&
      payload.runner_environment === 'self-hosted' &&
      ['workflow_dispatch', 'issues'].includes(
        expected.eventName ?? 'workflow_dispatch',
      ) &&
      payload.event_name === (expected.eventName ?? 'workflow_dispatch') &&
      payload.workflow_ref === expected.workflowRef &&
      payload.workflow_sha === expected.sourceCommit &&
      payload.sha === expected.sourceCommit &&
      payload.ref === expected.ref &&
      payload.ref_type === 'branch' &&
      !payload.head_ref &&
      !payload.base_ref,
    'OIDC_CALLER_MISMATCH',
  );
  if (expected.reusable) {
    requireThat(
      isSha(expected.reusable.commit) &&
        payload.job_workflow_sha === expected.reusable.commit &&
        payload.job_workflow_ref === expected.reusable.ref,
      'OIDC_REUSABLE_SOURCE_MISMATCH',
    );
  } else
    requireThat(
      !payload.job_workflow_ref && !payload.job_workflow_sha,
      'UNEXPECTED_REUSABLE_WORKFLOW',
    );
  return {
    repositoryId: expected.repositoryId,
    runId: expected.runId,
    attempt: expected.attempt,
    actorId: expected.actorId,
    checkRunId: expected.checkRunId,
    sourceCommit: expected.sourceCommit,
    expiresAt: payload.exp * 1000,
    identityHash: digest({ header, payload }),
  };
}

// Values come from the trusted Actions process environment, not Issue/workflow
// inputs. Only GitHub's runner token service may receive the request credential.
export async function requestActionsIdentity(
  { requestUrl, requestToken, audience },
  fetcher = fetch,
) {
  const url = new URL(requestUrl);
  requireThat(
    url.protocol === 'https:' &&
      url.hostname.endsWith('.actions.githubusercontent.com') &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.hash &&
      typeof requestToken === 'string' &&
      requestToken &&
      typeof audience === 'string' &&
      audience.startsWith('nibfin:'),
    'UNTRUSTED_OIDC_REQUEST',
  );
  url.searchParams.set('audience', audience);
  const response = await fetcher(url.href, {
    method: 'GET',
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
    headers: { Authorization: `Bearer ${requestToken}` },
  });
  requireThat(response.ok, 'OIDC_TOKEN_UNAVAILABLE');
  const text = await response.text();
  requireThat(Buffer.byteLength(text) <= 65536, 'OIDC_RESPONSE_TOO_LARGE');
  const value = JSON.parse(text).value;
  requireThat(
    typeof value === 'string' && value.length <= 32768,
    'OIDC_TOKEN_UNAVAILABLE',
  );
  return value;
}

// This factory is used by the installed launcher, never by an event payload.
// Pin and request credentials remain outside all Agent/container environments.
export function actionsCaller({
  pin,
  requestUrl,
  requestToken,
  executionId,
  fetcher = fetch,
  clock = Date.now,
}) {
  requireThat(
    typeof executionId === 'string' && /^[a-f0-9-]{36}$/.test(executionId),
    'INVALID_CALLER_EXECUTION',
  );
  const fixed = structuredClone(pin),
    audience = `nibfin:${fixed.repositoryId}:${executionId}`;
  return async (runner) => {
    const token = await requestActionsIdentity(
      { requestUrl, requestToken, audience },
      fetcher,
    );
    return verifyActionsIdentity(
      token,
      {
        ...fixed,
        audience,
        runId: runner.runId,
        attempt: runner.attempt,
        actorId: runner.actorId,
        checkRunId: runner.checkRunId,
        sourceCommit: runner.sourceCommit,
      },
      { fetcher, now: clock() },
    );
  };
}
