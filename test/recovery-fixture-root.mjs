import { lstat, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { privateHostDirectory } from '../src/host-fence.mjs';
import { safePath } from '../src/local-work-files.mjs';

async function directoryIdentity(path) {
  const stat = await lstat(path, { bigint: true });
  if (!stat.isDirectory() || await realpath(path) !== path) {
    throw Object.assign(new Error('Fixture directory identity changed'), {
      code: 'RECOVERY_FIXTURE_DIRECTORY_CHANGED',
    });
  }
  return { dev: stat.dev, ino: stat.ino };
}

function sameIdentity(before, after) {
  return before?.dev === after.dev && before?.ino === after.ino;
}

async function retireFixture(base, parent, root, owned) {
  let currentParent;
  try { currentParent = await directoryIdentity(base); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (!sameIdentity(parent, currentParent)) {
    throw Object.assign(new Error('Fixture base changed before cleanup'), {
      code: 'RECOVERY_FIXTURE_DIRECTORY_CHANGED',
    });
  }
  let current;
  try { current = await directoryIdentity(root); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (!sameIdentity(owned, current)) {
    throw Object.assign(new Error('Fixture root changed before cleanup'), {
      code: 'RECOVERY_FIXTURE_DIRECTORY_CHANGED',
    });
  }
  await rm(root, { recursive: true, force: true });
}

// Standard role scratch is supplied by Core; callers can select a permitted
// base independently. Never repair its permissions or fall back to another base.
export async function recoveryFixtureRoot(t, { base = tmpdir() } = {}) {
  let root;
  try {
    if (process.platform !== 'linux') {
      throw Object.assign(new Error('Recovery requires a Linux journal host'), {
        code: 'UNSUPPORTED_JOURNAL_HOST',
      });
    }
    base = resolve(base);
    const parent = await directoryIdentity(base);
    root = await mkdtemp(join(base, 'nibfin-deliver-recovery-'));
    // Register before validation, so even rejected setup is owned and retired.
    let owned;
    const cleanup = () => retireFixture(base, parent, root, owned);
    t.after(cleanup);
    owned = await directoryIdentity(root);
    await privateHostDirectory(root);
    await safePath(root, process.getuid());
    return { root, cleanup, environment: {
      ...process.env, TMPDIR: root, TMP: root, TEMP: root,
    } };
  } catch (cause) {
    const error = new Error(
      `Recovery fixture setup unavailable (${cause.code ?? 'UNKNOWN'}): ${base}`,
      { cause });
    error.code = 'RECOVERY_FIXTURE_SETUP_UNAVAILABLE';
    error.base = base;
    error.root = root;
    throw error;
  }
}
