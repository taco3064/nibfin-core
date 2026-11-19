import { constants } from 'node:fs';
import { cp, lstat, mkdir, open, readFile, readdir, rename, rm }
  from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { coreRoot } from './host-adoption.mjs';
import { rootOwnedPath } from './host-paths.mjs';
import { managerRoot, managerPin, installationRoot } from './rollout-manager-context.mjs';
import { requireThat, isId } from './identity.mjs';
import { withKernelGate } from './kernel-gate.mjs';
import { syncRecoveryDirectory } from './recovery-lock.mjs';
import { writeRetirementFile } from './retirement-files.mjs';
import { installedSharedRuntime } from './shared-platform.mjs';
import { verifyOwnedSourcePackage } from './owned-source-package.mjs';

async function preparedLayout(path, source, prefix = '') {
  await rootOwnedPath(path);
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const current = join(path, entry.name);
    await rootOwnedPath(current);
    const expected = await lstat(join(source, relative));
    requireThat(entry.isDirectory() === expected.isDirectory() &&
      !expected.isSymbolicLink(), 'ROLLOUT_MANAGER_PREPARED_SOURCE_UNKNOWN');
    if (entry.isDirectory()) await preparedLayout(current, source, relative);
    else requireThat(entry.isFile() && expected.isFile(),
      'ROLLOUT_MANAGER_PREPARED_SOURCE_UNKNOWN');
  }
}

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

// Explicit normal privileged installation. Copy the complete verified package,
// including its manifest, rather than guessing the lazy dependency closure.
export async function installCoreRolloutManager() {
  const runtime = await installedAdministrator();
  const directory = '/etc/nibfin';
  await rootOwnedPath(directory);
  const gate = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY |
    constants.O_NOFOLLOW);
  try {
    return await withKernelGate(gate, async () => {
      try {
        await lstat(join(directory, 'rollout-plan.json'));
        requireThat(false, 'ROLLOUT_MANAGER_INSTALL_DURING_OPERATION');
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const host = JSON.parse(await readFile(join(directory, 'host.json'), 'utf8'));
      const pin = host.installation?.pin;
      requireThat(host.installation?.directory === installationRoot,
        'INVALID_HOST_ADOPTION');
      await verifyOwnedSourcePackage(coreRoot, pin);
      const base = dirname(managerRoot);
      await rootOwnedPath(dirname(base));
      await mkdir(base, { mode: 0o755, recursive: false }).catch(error => {
        if (error.code !== 'EEXIST') throw error;
      });
      await rootOwnedPath(base);
      // The same existing directory gate excludes active administrator work.
      // Verify an old installed manager before retiring its now-unused closure.
      let previous = false;
      try {
        await lstat(managerRoot);
        try {
          await verifyOwnedSourcePackage(managerRoot, pin);
          await writeRetirementFile(managerPin, pin);
          await writeRetirementFile(join(base, 'runtime.json'),
            { nodePath: runtime.nodePath });
          return { status: 'installed', source: pin };
        } catch (error) {
          if (error.code !== 'SOURCE_MANIFEST_MISMATCH') throw error;
        }
        const installedPin = JSON.parse(await readFile(managerPin, 'utf8'));
        await verifyOwnedSourcePackage(managerRoot, installedPin);
        previous = true;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const staged = join(base, 'prepared');
      let stagedExists = false;
      try { await lstat(staged); stagedExists = true; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (!stagedExists) {
        await mkdir(staged, { mode: 0o755 });
      }
      // This unpublished, fixed staging tree cannot be admitted as a manager.
      // Known generated files may be copied again after a partial installation;
      // foreign paths, symlinks and writable ownership are never overwritten.
      await preparedLayout(staged, coreRoot);
      await cp(coreRoot, staged, { recursive: true, force: true, dereference: false });
      await verifyOwnedSourcePackage(staged, pin);
      if (previous) await rm(managerRoot, { recursive: true });
      await rename(staged, managerRoot);
      await writeRetirementFile(managerPin, pin);
      await writeRetirementFile(join(base, 'runtime.json'),
        { nodePath: runtime.nodePath });
      await syncRecoveryDirectory(base);
      return { status: 'installed', source: pin };
    });
  } finally { await gate.close(); }
}

export async function runCoreRollout(run, artifact) {
  const target = administratorTarget(run, artifact);
  await installedAdministrator();
  await rootOwnedPath(managerRoot);
  await rootOwnedPath(managerPin);
  const pin = JSON.parse(await readFile(managerPin, 'utf8'));
  await verifyOwnedSourcePackage(managerRoot, pin);
  return runManagerProcess([String(target.runId), String(target.artifactId)]);
}

function runManagerProcess(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/python3',
      [join(managerRoot, 'scripts/core-rollout-admin.py'), ...args], {
        cwd: dirname(managerRoot), shell: false,
        env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C',
          PYTHONDONTWRITEBYTECODE: '1' },
        stdio: ['ignore', 'pipe', 'inherit'],
      });
    const chunks = [];
    child.stdout.on('data', bytes => chunks.push(bytes));
    child.once('error', reject);
    child.once('close', code => {
      try {
        const result = JSON.parse(Buffer.concat(chunks).toString());
        requireThat([0, 2].includes(code), 'CORE_ROLLOUT_OPERATION_FAILED');
        resolve(result);
      } catch (error) { reject(error); }
    });
  });
}
