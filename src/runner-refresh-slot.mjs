import { mkdir, mkdtemp, open, readdir, readFile, rename }
  from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rootOwnedPath } from './host-paths.mjs';
import { command } from './process.mjs';
import { digest, requireThat } from './identity.mjs';
import { optionalStat } from './retirement-files.mjs';
import { syncRecoveryDirectory } from './recovery-lock.mjs';
import { deriveOfficialRunnerIdentity, verifyRunnerIdentityFiles }
  from './installed-runner-identity.mjs';
import { publishInstalledRunnerIdentity, readInstalledRunnerIdentity }
  from './installed-runner-state.mjs';
import { verifySharedSlotIdentity } from './shared-slot-identity.mjs';
import { verifyProgramTree } from './security/shared-runner-start-check.mjs';
import { runnerEntryIdentity } from './runner-refresh-files.mjs';
import { cleanupRefreshEntries } from './runner-refresh-cleanup.mjs';

const reserved = new Set(['.runner', '.credentials', '.credentials_rsaparams',
  '.env', '.path', '_work', '_diag', '.nibfin-runner-identity.json']);

export async function prepareRunnerSlot(directory, scratch, archive, selected,
  runner, repository, target, { run = command } = {}) {
  await rootOwnedPath(directory);
  const local = await verifySharedSlotIdentity(directory, runner, repository);
  const identity = await deriveOfficialRunnerIdentity(archive,
    selected.release, selected.arch, local);
  await mkdir(scratch, { recursive: true, mode: 0o700 });
  await rootOwnedPath(scratch);
  const staged = await mkdtemp(join(scratch, 'staged-'));
  await rootOwnedPath('/usr/bin/tar');
  await run('/usr/bin/tar', ['--extract', '--gzip', '--file', archive,
    '--directory', staged, '--no-same-owner', '--same-permissions'],
  { env: { PATH: '/usr/bin:/bin', LANG: 'C' } });
  const names = (await readdir(staged)).sort();
  requireThat(names.includes('bin') && names.includes('externals') &&
    names.every(name => !reserved.has(name)), 'RUNNER_REFRESH_PACKAGE_LAYOUT_INVALID');
  const worker = join(staged, 'bin/Runner.Worker');
  await rename(worker, worker + '.official');
  const dispatcher = new URL('./security/shared-worker-dispatcher.sh', import.meta.url);
  await rootOwnedPath(fileURLToPath(dispatcher));
  const file = await open(worker, 'wx', 0o755);
  try {
    await file.writeFile(await readFile(dispatcher));
    await file.chmod(0o755);
    await file.sync();
  } finally { await file.close(); }
  await verifyRunnerIdentityFiles(staged, identity, target);
  await verifyProgramTree(join(staged, 'bin'));
  await verifyProgramTree(join(staged, 'externals'));
  const entries = [];
  for (const name of names) entries.push({ name,
    previous: await runnerEntryIdentity(join(directory, name)),
    next: await runnerEntryIdentity(join(staged, name)) });
  await mkdir(join(scratch, 'previous'), { recursive: true, mode: 0o700 });
  await rootOwnedPath(join(scratch, 'previous'));
  await syncRecoveryDirectory(scratch);
  return { identity, entries, staged };
}

// Rename readback covers interruption before/after either move. Unknown bytes
// never authorize overwriting live or retained material.
export async function applyRunnerSlot(directory, scratch, intent, target, {
  move = rename,
} = {}) {
  await rootOwnedPath(directory);
  await rootOwnedPath(scratch);
  const registration = intent.identity.registration;
  const expected = { id: registration.id, name: registration.name };
  const repository = registration.url.slice('https://github.com/'.length);
  await verifySharedSlotIdentity(directory, expected, repository);
  requireThat(dirname(intent.staged) === scratch &&
    /^staged-[A-Za-z0-9]+$/.test(basename(intent.staged)),
  'RUNNER_REFRESH_STAGING_CHANGED');
  for (const entry of intent.entries) {
    requireThat(typeof entry.name === 'string' && entry.name !== '.' &&
      entry.name !== '..' && !/[\\/]/.test(entry.name) && !reserved.has(entry.name),
    'RUNNER_REFRESH_PACKAGE_LAYOUT_INVALID');
    const live = join(directory, entry.name);
    const staged = join(intent.staged, entry.name);
    const prior = join(scratch, 'previous', entry.name);
    const actual = await runnerEntryIdentity(live);
    const old = await runnerEntryIdentity(prior);
    const next = await runnerEntryIdentity(staged);
    if (actual === entry.next) continue;
    requireThat(next === entry.next && old === null && actual === entry.previous ||
      next === entry.next && actual === null &&
        (old === entry.previous || old === null),
    'RUNNER_REFRESH_READBACK_UNKNOWN');
    if (actual !== null) {
      await move(live, prior);
      await syncRecoveryDirectory(directory);
      await syncRecoveryDirectory(join(scratch, 'previous'));
    }
    await move(staged, live);
    await syncRecoveryDirectory(directory);
    await syncRecoveryDirectory(intent.staged);
  }
  await publishRunnerSlotIdentity(directory, intent, expected, repository, target);
}

async function publishRunnerSlotIdentity(directory, intent, expected,
  repository, target) {
  await verifyRunnerIdentityFiles(directory, intent.identity, target);
  const local = await verifySharedSlotIdentity(directory, expected, repository);
  let installed;
  try { installed = await readInstalledRunnerIdentity(directory, local, target); }
  catch (error) {
    if (!['ENOENT', 'INVALID_INSTALLED_RUNNER_IDENTITY', 'INVALID_RUNNER_RELEASE',
      'SHARED_ARTIFACT_DIGEST_MISMATCH', 'SHARED_PLATFORM_MISMATCH'].includes(error.code)
        && !(error instanceof SyntaxError)) throw error;
  }
  if (JSON.stringify(installed) !== JSON.stringify(intent.identity))
    await publishInstalledRunnerIdentity(directory, intent.identity, target);
}

// A missing disposable extraction is unfinished preparation. Recreate it from
// the same verified official archive without replacing the saved old/live intent.
export async function resumeRunnerSlot(directory, scratch, archive, selected,
  intent, runner, repository, target) {
  if (await finalizeRunnerSlot(directory, intent, runner, repository, target)) return;
  let missing = intent.staged === null;
  for (const entry of intent.entries) {
    const live = await runnerEntryIdentity(join(directory, entry.name));
    if (live !== entry.next &&
      (!intent.staged || !await optionalStat(join(intent.staged, entry.name))))
      missing = true;
  }
  if (missing || dirname(intent.staged) !== scratch) await restageRunnerSlot(
    directory, scratch, archive, selected, intent, runner, repository, target);
  await applyRunnerSlot(directory, scratch, intent, target);
}

// Confirm actual desired files before touching disposable preparation. This
// also completes an interrupted metadata publication without downloading or
// replacing already confirmed binaries again.
export async function finalizeRunnerSlot(directory, intent, runner, repository, target) {
  await verifySharedSlotIdentity(directory, runner, repository);
  for (const entry of intent.entries)
    if (await runnerEntryIdentity(join(directory, entry.name)) !== entry.next)
      return false;
  await publishRunnerSlotIdentity(directory, intent, runner, repository, target);
  return true;
}

export async function restageRunnerSlot(directory, scratch, archive, selected,
  intent, runner, repository, target) {
  const regenerated = await prepareRunnerSlot(directory, scratch, archive,
    selected, runner, repository, target);
  requireThat(digest(regenerated.identity) === digest(intent.identity) &&
    digest(regenerated.entries.map(({ name, next }) => ({ name, next }))) ===
    digest(intent.entries.map(({ name, next }) => ({ name, next }))),
  'RUNNER_REFRESH_STAGING_CHANGED');
  if (intent.staged) await cleanupRefreshEntries(intent.staged, intent.entries, 'next');
  intent.staged = regenerated.staged;
}

export async function verifyRefreshedSlot(directory, intent, runner, repository, target) {
  const local = await verifySharedSlotIdentity(directory, runner, repository);
  for (const entry of intent.entries)
    requireThat(await runnerEntryIdentity(join(directory, entry.name)) === entry.next,
      'RUNNER_REFRESH_READBACK_UNKNOWN');
  const identity = await readInstalledRunnerIdentity(directory, local, target);
  requireThat(JSON.stringify(identity) === JSON.stringify(intent.identity),
    'RUNNER_REFRESH_IDENTITY_CHANGED');
}
