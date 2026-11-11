#!/usr/bin/env node
import { rootOwnedPath } from '../src/host-paths.mjs';
import { hostFile, coreRoot, boundedHostFile } from '../src/host-adoption.mjs';
import { controllerRoute, readControllerInput } from '../src/controller-contract.mjs';
import { launchStage } from '../src/host-launcher.mjs';
import { launchIssueWake } from '../src/host-issue-wake.mjs';
import { requireThat } from '../src/identity.mjs';
import { observationFailureCode } from '../src/observation-failure.mjs';

async function main() {
  await rootOwnedPath(hostFile);
  await rootOwnedPath(coreRoot);
  const host = JSON.parse(await boundedHostFile(hostFile, 262144));
  requireThat(
    controllerRoute(host) &&
      process.getuid() === host.uid &&
      Number(process.env.NIBFIN_INVOKER_UID) === host.runnerUid &&
      coreRoot === '/opt/nibfin/core' &&
      host.installation?.directory === coreRoot,
    'UNTRUSTED_CONTROLLER_CALLER',
  );
  const request = await readControllerInput(process.stdin);
  if (request.command === 'stage') {
    return launchStage(request.issue, request.stage, request.context);
  }
  return launchIssueWake(request.issue, request.context, request.event);
}

main()
  .catch((error) => ({
    status: 'denied',
    code: /^[A-Z][A-Z0-9_]{0,99}$/.test(error.code ?? '')
      ? error.code
      : Number.isInteger(error.status)
        ? observationFailureCode(error)
        : 'CONTROLLER_REQUEST_DENIED',
  }))
  .then((result) => process.stdout.write(JSON.stringify(result) + '\n'));
