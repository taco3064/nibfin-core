import { rootOwnedPath } from './host-paths.mjs';
import { hostFile, coreRoot } from './host-adoption.mjs';
import { boundedHostFile } from './host-adoption.mjs';
import { command } from './process.mjs';
import { requireThat, isId } from './identity.mjs';
import {
  contextKeys,
  controllerProgram,
  controllerRelayProgram,
  controllerRelayArguments,
  controllerRoute,
  validateControllerRequest,
} from './controller-contract.mjs';

// No listener, queue or alternate admission: this relays one bounded invocation
// to the same installed Core under the private controller's OS identity.
export async function relayHostCommand(operation, values, env = process.env) {
  requireThat(
    /^[1-9][0-9]*$/.test(values[0]) && isId(Number(values[0])),
    'INVALID_ADOPTED_ISSUE',
  );
  await rootOwnedPath(hostFile);
  await rootOwnedPath(coreRoot);
  const host = JSON.parse(await boundedHostFile(hostFile, 262144));
  if (!controllerRoute(host) || process.getuid() === host.uid) return null;
  requireThat(
    process.getuid() === host.runnerUid &&
      host.installation?.directory === coreRoot &&
      coreRoot === '/opt/nibfin/core',
    'UNTRUSTED_CONTROLLER_CALLER',
  );
  await rootOwnedPath(controllerProgram);
  const context = Object.fromEntries(contextKeys.map((key) => [key, env[key]]));
  const request = validateControllerRequest({
    schemaVersion: 1,
    command: operation,
    issue: values[0],
    context,
    ...(operation === 'stage'
      ? { stage: values[1] }
      : {
          event: await boundedHostFile(env.GITHUB_EVENT_PATH, 1048576),
        }),
  });
  return relayControllerRequest(request, host.uid);
}

// After handoff, transport failure cannot prove that the privileged writer
// stopped. Never downgrade an unknown external effect to a retryable denial.
export async function relayControllerRequest(request, uid, run = command) {
  try {
    const result = await run(
      controllerRelayProgram,
      controllerRelayArguments(uid),
      {
        cwd: coreRoot,
        env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
        input: JSON.stringify(request),
        timeout: 3600000,
        limit: 1048576,
      },
    );
    const value = JSON.parse(result.stdout.toString());
    requireThat(
      ['completed', 'denied', 'pending', 'scheduled', 'skipped'].includes(value.status),
      'CONTROLLER_RESPONSE_UNPROVEN',
    );
    return value;
  } catch {
    return {
      schemaVersion: 1,
      status: 'pending',
      code: 'CONTROLLER_HANDOFF_UNRESOLVED',
      ...(request.command === 'stage' ? { stage: request.stage } : {}),
    };
  }
}
