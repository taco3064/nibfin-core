import { appendFile } from 'node:fs/promises';
import { requireThat } from '../src/identity.mjs';

// This is a disclosure allowlist, never an authorization decision. Unknown
// messages, provider bodies, URLs, stacks and arbitrary codes stay private.
const publicCodes = new Set([
  'INVALID_ROUTING_OUTPUT',
  'INVALID_ISSUE_WAKE',
  'UNTRUSTED_ISSUE_EVENT_RUN',
  'UNTRUSTED_WAKE_CALLER',
  'WAKE_TARGET_NOT_READY',
  'INACTIVE_WAKE_TARGET',
  'WAKE_CALLER_CHANGED',
  'ISSUE_EVENT_SOURCE_CHANGED',
  'INVALID_WAKE_ADOPTION',
  'WAKE_SOURCE_CHANGED',
  'APPROVAL_RECORD_CHANGED',
  'APPROVAL_PR_CHANGED_OR_BLOCKED',
  'PROTECTION_CHANGED',
  'RULESET_NOT_ADOPTED',
  'MEMBER_PERMISSION_REVOKED',
  'WAKE_WORKFLOW_SOURCE_CHANGED',
]);
const publicHttpStatuses = new Set([401, 403, 404, 429, 500, 502, 503, 504]);

function diagnosticCode(error) {
  if (!(error instanceof Error)) return 'WAKE_RESOLUTION_FAILED';
  const code = Object.getOwnPropertyDescriptor(error, 'code')?.value;
  if (publicCodes.has(code)) return code;
  const status = Object.getOwnPropertyDescriptor(error, 'status')?.value;
  return publicHttpStatuses.has(status)
    ? `GITHUB_READ_HTTP_${status}`
    : 'WAKE_RESOLUTION_FAILED';
}

export async function routingOutput(resolve, keys) {
  try {
    const result = await resolve();
    requireThat(
      result.status === 'resolved' &&
        keys.every(
          (key) => typeof result[key] === 'string' && /^[a-z0-9-]+$/.test(result[key]),
        ),
      'INVALID_ROUTING_OUTPUT',
    );
    await appendFile(
      process.env.GITHUB_OUTPUT,
      keys.map((key) => `${key}=${result[key]}\n`).join(''),
    );
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (error) {
    process.stderr.write('Wake resolution denied; no stage was admitted.\n');
    process.stderr.write(JSON.stringify({
      schemaVersion: 1,
      status: 'denied',
      code: diagnosticCode(error),
      stageAdmitted: false,
    }) + '\n');
    process.exitCode = 1;
  }
}
