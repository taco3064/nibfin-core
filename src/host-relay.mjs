import {
  isReconciledResult, isUnfinishedObservation, reconciledFailure,
} from './reconciliation-result.mjs';
import { githubReadWaiting, githubApiWaiting } from './observation-failure.mjs';
import { rootOwnedPath } from './host-paths.mjs';
import { hostFile, coreRoot } from './host-adoption.mjs';
import { boundedHostFile } from './host-adoption.mjs';
import { command, deliveryTransportTimeout } from './process.mjs';
import { requireThat, isId } from './identity.mjs';
import {
  contextKeys,
  targetContextKey,
  controllerProgram,
  controllerRelayProgram,
  controllerRelayArguments,
  controllerRoute,
  controllerRunnerUids,
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
    controllerRunnerUids(host).includes(process.getuid()) &&
      host.installation?.directory === coreRoot &&
      coreRoot === '/opt/nibfin/core',
    'UNTRUSTED_CONTROLLER_CALLER',
  );
  await rootOwnedPath(controllerProgram);
  const context = Object.fromEntries(contextKeys.map((key) => [key, env[key]]));
  if (env[targetContextKey] !== undefined)
    context[targetContextKey] = env[targetContextKey];
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
  const invoke = async value => {
    let result;
    try {
      result = await run(controllerRelayProgram, controllerRelayArguments(uid), {
        cwd: coreRoot,
        env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
        input: JSON.stringify(value),
        timeout: value.command === 'reconcile-stage'
          ? 15 * 60000 : deliveryTransportTimeout,
        limit: 1048576,
      });
    } catch {
      throw new Error('TRANSPORT_FAILED');
    }
    try {
      const parsed = JSON.parse(result.stdout.toString());
      requireThat(parsed && typeof parsed === 'object' &&
        ['completed', 'denied', 'pending', 'scheduled', 'skipped']
          .includes(parsed.status), 'CONTROLLER_RESPONSE_UNPROVEN');
      return parsed;
    } catch {
      throw new Error('RESPONSE_INVALID');
    }
  };
  let initialFailure;
  try { return await invoke(request); }
  catch (error) { initialFailure = error.message; }
  let reconciliationFailure;
  if (request.command === 'stage') {
    try {
      const observed = await invoke({ ...request, command: 'reconcile-stage' });
      if (isReconciledResult(observed, request.stage)) return observed;
      if (initialFailure === 'RESPONSE_INVALID' &&
          isUnfinishedObservation(observed, request.stage)) {
        // A returned transport has stopped. Re-enter once through native
        // admission after the settlement read; a timeout does not prove exit.
        const result = await invoke(request);
        return result.stage === undefined ? { ...result, stage: request.stage } : result;
      }
      if (observed.schemaVersion === 1 && observed.stage === request.stage &&
        observed.status === 'pending' &&
        [githubReadWaiting, githubApiWaiting].includes(observed.code)) return observed;
      reconciliationFailure = reconciledFailure(observed, request.stage);
    } catch (error) { reconciliationFailure = error.message; }
  }
  return {
    schemaVersion: 1,
    status: 'pending',
    code: 'CONTROLLER_HANDOFF_UNRESOLVED',
    ...(request.command === 'stage' ? { initialFailure } : {}),
    ...(reconciliationFailure ? { reconciliationFailure } : {}),
    ...(request.command === 'stage' ? { stage: request.stage } : {}),
  };
}
