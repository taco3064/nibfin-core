import { lstat, readdir, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { coreRoot } from './host-adoption.mjs';
import { rootOwnedPath } from './host-paths.mjs';
import { withSharedAdoptionLock } from './shared-peer-adoption.mjs';
import { requireThat } from './identity.mjs';
import { managedCredentialHost } from './managed-credential-host.mjs';
import { privateCredentialPipe, readCredentialInput } from
  './managed-credential-input.mjs';
import {
  lifecycleState, publishPrivate, readPrivate, sameResource,
  withCredentialLock, writeLifecycle,
} from './managed-credential-files.mjs';
import { verifyManagedAuthority } from './managed-credential-authority.mjs';
import { managedSettlement } from './managed-credential-settlement.mjs';
import { syncRecoveryDirectory } from './recovery-lock.mjs';

export const credentialGuidance =
  'GitHub CLI logout does not revoke an imported token. Imported tokens retain ' +
  'their provider permissions. Disconnect removes only Controller-managed access; ' +
  'original login stores and unrelated authorizations remain unchanged.';

const paths = host => [host.tokenFile, host.authFile];
async function absent(path) {
  try { await lstat(path); requireThat(false, 'MANAGED_CREDENTIAL_FILE_CONFLICT'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

async function assertOwned(host, state) {
  for (const [index, path] of paths(host).entries())
    await sameResource(path, host, state.files?.[index]);
}

async function consumersSettled(host) {
  const entries = await readdir(dirname(host.tokenFile));
  requireThat(!entries.some(name => name.startsWith('consumer-')),
    'MANAGED_CREDENTIAL_CONSUMER_PENDING');
  await managedSettlement(host);
}

// Shared implementation exercised with disposable private directories in tests.
// The command entry never accepts host, reader or settlement callbacks as input.
export async function manageCredentials(host, operation, material, {
  verify = verifyManagedAuthority, settle = consumersSettled,
} = {}) {
  requireThat(['intake', 'replace', 'disconnect', 'status'].includes(operation),
    'MANAGED_CREDENTIAL_OPERATION_INVALID');
  if (operation === 'status') return withCredentialLock(host, async () => {
    const state = await lifecycleState(host);
    if (!state) return { status: 'manual', guidance: credentialGuidance };
    let access = 'unverified';
    if (state.phase === 'active') {
      await assertOwned(host, state);
      try {
        await verify(host, (await readPrivate(host.tokenFile, host, 16384)).trim());
        access = 'authorized';
      } catch (error) {
        access = error.code === 'MANAGED_CREDENTIAL_PROVIDER_UNAVAILABLE'
          ? 'unavailable' : 'unauthorized';
      }
    }
    let status = state.phase;
    if (['installing', 'disconnecting'].includes(state.phase) || access === 'unavailable')
      status = 'pending';
    else if (access === 'unauthorized') status = 'denied';
    return { status, phase: state.phase, access, memberId: state.memberId,
      guidance: credentialGuidance };
  });
  return withCredentialLock(host, async () => {
    const state = await lifecycleState(host);
    if (operation === 'disconnect') {
      requireThat(state, 'MANAGED_CREDENTIAL_NOT_ENROLLED');
      if (state.phase === 'disconnected')
        return { status: 'disconnected', guidance: credentialGuidance };
      requireThat(['active', 'installing', 'disconnecting'].includes(state.phase),
        'MANAGED_CREDENTIAL_TRANSITION_PENDING');
      const stopping = { ...state, phase: 'disconnecting' };
      await writeLifecycle(host, stopping);
      // Stop admission before checking consumers. Do not kill or retry unknown work.
      try { await settle(host); }
      catch { return { status: 'pending', code: 'MANAGED_CREDENTIAL_SETTLEMENT_PENDING',
        guidance: credentialGuidance }; }
      const removable = [];
      for (const [index, path] of paths(host).entries()) {
        try { await sameResource(path, host, state.files?.[index]); }
        catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        removable.push({ path, identity: state.files[index] });
      }
      for (const { path, identity } of removable) {
        await sameResource(path, host, identity);
        await unlink(path);
        await syncRecoveryDirectory(dirname(path));
      }
      await writeLifecycle(host, { schemaVersion: 1, memberId: host.memberId,
        phase: 'disconnected', files: [] });
      return { status: 'disconnected', guidance: credentialGuidance };
    }
    if (operation === 'replace') {
      requireThat(state?.phase === 'active', 'MANAGED_CREDENTIAL_NOT_REPLACEABLE');
      await assertOwned(host, state);
    } else {
      requireThat(!state || state.phase === 'disconnected',
        'MANAGED_CREDENTIAL_ALREADY_ENROLLED');
      for (const path of paths(host)) await absent(path);
    }
    requireThat(material && typeof material.token === 'string' &&
      typeof material.auth === 'string', 'MANAGED_CREDENTIAL_INPUT_INVALID');
    await verify(host, material.token);
    await settle(host);
    const next = { schemaVersion: 1, memberId: host.memberId,
      phase: 'installing', files: [...(state?.files ?? [])] };
    await writeLifecycle(host, next);
    // An interrupted multi-file transition remains blocked, never partly active.
    try {
      const values = [material.token + '\n', material.auth];
      for (const [index, bytes] of values.entries()) {
        next.files[index] = await publishPrivate(paths(host)[index], bytes, host,
          state?.files?.[index]);
        await writeLifecycle(host, next);
      }
      for (const [index, path] of paths(host).entries())
        requireThat(await readPrivate(path, host) === values[index],
          'MANAGED_CREDENTIAL_READBACK_FAILED');
      await writeLifecycle(host, { ...next, phase: 'active' });
      return { status: 'active', memberId: host.memberId,
        guidance: credentialGuidance };
    } catch (error) {
      let rolledBack = false;
      if (operation === 'intake') {
        try {
          for (const [index, path] of paths(host).entries()) {
            if (!next.files[index]) continue;
            await sameResource(path, host, next.files[index]);
            await unlink(path);
            await syncRecoveryDirectory(dirname(path));
          }
          // A publication may have linked a file before failing its final sync.
          // An unrecorded inode is unknown: never claim its removal or delete it.
          for (const path of paths(host)) await absent(path);
          await writeLifecycle(host, { schemaVersion: 1, memberId: host.memberId,
            phase: 'disconnected', files: [] });
          rolledBack = true;
        } catch { /* Keep the durable installing state for trusted recovery. */ }
      }
      if (rolledBack) throw error;
      const code = 'MANAGED_CREDENTIAL_TRANSITION_PENDING';
      throw Object.assign(new Error(code), { code });
    }
  });
}

export async function credentialAdministrator(operation, input = process.stdin) {
  try {
    requireThat(process.platform === 'linux' && process.getuid() === 0 &&
      coreRoot === '/opt/nibfin/core', 'MANAGED_CREDENTIAL_REQUIRES_LOCAL_ADMIN');
    await rootOwnedPath(coreRoot);
    return await withSharedAdoptionLock(async () => {
      const host = await managedCredentialHost(true, operation === 'intake');
      let material;
      if (['intake', 'replace'].includes(operation)) {
        privateCredentialPipe();
        material = await readCredentialInput(input);
      }
      return manageCredentials(host, operation, material);
    });
  } catch (error) {
    const code = /^MANAGED_[A-Z_]{1,75}$/.test(error.code ?? '')
      ? error.code : 'MANAGED_CREDENTIAL_OPERATION_FAILED';
    return { status: (code.endsWith('_PENDING') || code.endsWith('_UNAVAILABLE'))
      ? 'pending' : 'denied', code,
      guidance: code === 'MANAGED_CODEX_DEDICATED_LOGIN_REQUIRED'
        ? 'Use CLI-1 to complete a dedicated Controller ChatGPT file-mode login, ' +
          'then retry intake. The active login was not changed.'
        : credentialGuidance };
  }
}

// Admissions serialize only while verifying and registering a consumer. Existing
// consumers may run concurrently; replacement and disconnect must settle them.
export async function consumeManagedCredentials(host, action, {
  reconcile = false, verify = verifyManagedAuthority,
} = {}) {
  const lease = join(dirname(host.tokenFile), `consumer-${randomUUID()}`);
  await withCredentialLock(host, async () => {
    const state = await lifecycleState(host);
    requireThat(state && (state.phase === 'active' ||
      reconcile && state.phase === 'disconnecting'),
    'MANAGED_CREDENTIAL_ADMISSION_DENIED');
    await assertOwned(host, state);
    if (!reconcile)
      await verify(host, (await readPrivate(host.tokenFile, host, 16384)).trim());
    await publishPrivate(lease, JSON.stringify({ pid: process.pid }) + '\n', host);
  });
  try { return await action(); }
  finally {
    await unlink(lease);
    await syncRecoveryDirectory(dirname(lease));
  }
}
