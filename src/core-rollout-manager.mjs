import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { coreRoot } from './host-adoption.mjs';
import { rootOwnedPath } from './host-paths.mjs';
import { installationRoot } from './rollout-manager-context.mjs';
import { requireThat, isId } from './identity.mjs';
import { installedSharedRuntime } from './shared-platform.mjs';
import { installVerifiedRolloutManager } from './core-manager-installation.mjs';
import { verifyOwnedSourcePackage } from './owned-source-package.mjs';
import { installManagerEntries } from './core-maintenance-bootstrap.mjs';
import contract from './core-maintenance-installation.json' with { type: 'json' };
import { readRolloutProcessResult, rolloutFailure } from './core-rollout-result.mjs';

export function administratorTarget(run, artifact) {
  requireThat(/^[1-9][0-9]*$/.test(run ?? '') &&
    /^[1-9][0-9]*$/.test(artifact ?? '') &&
    isId(Number(run)) && isId(Number(artifact)), 'INVALID_CORE_ROLLOUT_TARGET');
  return { runId: Number(run), artifactId: Number(artifact) };
}

async function installedAdministrator() {
  requireThat(process.platform === 'linux' && process.getuid() === 0 &&
    coreRoot === installationRoot, 'ROLLOUT_REQUIRES_INSTALLED_ADMINISTRATOR');
  await rootOwnedPath(coreRoot);
  return installedSharedRuntime();
}

export async function installCoreRolloutManager() {
  const runtime = await installedAdministrator();
  const hostPath = '/etc/nibfin/host.json';
  await rootOwnedPath(hostPath);
  const host = JSON.parse(await readFile(hostPath, 'utf8'));
  requireThat(host.installation?.directory === installationRoot,
    'INVALID_HOST_ADOPTION');
  const installed = await installVerifiedRolloutManager(
    coreRoot, host.installation.pin, runtime, {
      observeSource: async () => {
        const current = JSON.parse(await readFile(hostPath, 'utf8'));
        requireThat(isDeepStrictEqual(current.installation, host.installation),
          'ROLLOUT_MANAGER_SOURCE_CHANGED');
        await verifyOwnedSourcePackage(coreRoot, host.installation.pin);
      },
    });
  return installManagerEntries(runtime, installed.directory);
}

export async function runCoreRollout(run, artifact, { coreOnly = false } = {}) {
  const target = administratorTarget(run, artifact);
  await installedAdministrator();
  await rootOwnedPath(contract.bridge);
  return runManagerProcess({ kind: 'administrator', target, coreOnly });
}

function runManagerProcess(request) {
  return new Promise(resolve => {
    const child = spawn(contract.bridge, [], {
        cwd: dirname(contract.bridge), shell: false,
        env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C',
          PYTHONDONTWRITEBYTECODE: '1' },
        stdio: ['pipe', 'pipe', 'inherit'],
      });
    const chunks = [];
    child.stdout.on('data', bytes => chunks.push(bytes));
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(request));
    child.once('error', error => resolve(rolloutFailure(error)));
    child.once('close', code => {
      resolve(readRolloutProcessResult(Buffer.concat(chunks).toString(), '', code));
    });
  });
}
