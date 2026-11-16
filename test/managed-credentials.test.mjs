import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, rm, chmod, symlink, writeFile } from
  'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { decodeCredentialInput, readCredentialInput, privateCredentialPipe } from
  '../src/managed-credential-input.mjs';
import { manageCredentials, consumeManagedCredentials } from
  '../src/managed-credentials.mjs';
import { lifecycleState, lifecyclePath, privateResource, readPrivate,
  withCredentialLock } from '../src/managed-credential-files.mjs';
import { verifyManagedAuthority } from '../src/managed-credential-authority.mjs';
import { managedSettlement } from '../src/managed-credential-settlement.mjs';
import { credentialAdministrator } from '../src/managed-credentials.mjs';
import { digest } from '../src/identity.mjs';

const secret = 'fake_github_credential_1234567890';
const wire = (token = secret) => Buffer.from(JSON.stringify({
  schemaVersion: 1, githubToken: token, codex: {
    auth_mode: 'chatgpt', tokens: { access_token: 'a'.repeat(25),
      refresh_token: 'r'.repeat(25), id_token: 'i'.repeat(25) },
  },
}));
const material = () => decodeCredentialInput(wire());
const verify = async () => {};
const options = { verify };

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'nibfin-managed-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ['state', 'credentials', 'codex'])
    await mkdir(join(root, name), { mode: 0o700 });
  return { uid: process.getuid(), gid: process.getgid(), memberId: 77,
    stateRoot: join(root, 'state'), tokenFile: join(root, 'credentials/github-token'),
    authFile: join(root, 'codex/auth.json'),
    credentialRepositories: [{ repository: 'owner/execution', repositoryId: 10 },
      { repository: 'owner/target', repositoryId: 20 }] };
}

function reader(host, change = () => {}) {
  const replies = new Map([['/user', { id: 77, login: 'owner', type: 'User' }]]);
  for (const value of host.credentialRepositories) {
    const path = '/repos/' + value.repository;
    replies.set(path, { id: value.repositoryId, full_name: value.repository,
      archived: false, disabled: false });
    replies.set(path + '/collaborators/owner/permission',
      { user: { id: 77 }, permission: 'admin' });
  }
  change(replies);
  return { get: async path => {
    assert.ok(replies.has(path), path);
    return replies.get(path);
  } };
}

test('bounded input validates supported file mode and rejects secrets', async () => {
  assert.equal((await readCredentialInput(Readable.from([wire()]))).token, secret);
  for (const bytes of [Buffer.alloc(65537), Buffer.from('{secret'),
    Buffer.from([255]), wire('short')]) {
    assert.throws(() => decodeCredentialInput(bytes),
      { code: 'MANAGED_CREDENTIAL_INPUT_INVALID' });
  }
  const unsupported = JSON.parse(wire());
  unsupported.codex = { auth_mode: 'apikey', OPENAI_API_KEY: secret };
  assert.throws(() => decodeCredentialInput(Buffer.from(JSON.stringify(unsupported))),
    { code: 'MANAGED_CODEX_DEDICATED_LOGIN_REQUIRED' });
  assert.throws(() => privateCredentialPipe(-1));
});

test('provider binds numeric member, both repositories, and native admin', async t => {
  const host = await fixture(t);
  await verifyManagedAuthority(host, secret, reader(host));
  for (const [path, patch, code] of [
    ['/user', { id: 88 }, 'MANAGED_CREDENTIAL_MEMBER_MISMATCH'],
    ['/repos/owner/target', { id: 99 }, 'MANAGED_CREDENTIAL_REPOSITORY_MISMATCH'],
    ['/repos/owner/execution/collaborators/owner/permission',
      { permission: 'write' }, 'MANAGED_CREDENTIAL_ADMIN_REQUIRED'],
    ['/repos/owner/target/collaborators/owner/permission',
      { permission: 'write' }, 'MANAGED_CREDENTIAL_ADMIN_REQUIRED'],
  ]) {
    const fake = reader(host, map => Object.assign(map.get(path), patch));
    await assert.rejects(verifyManagedAuthority(host, secret, fake), { code });
  }
  await assert.rejects(verifyManagedAuthority({ ...host,
    credentialRepositories: [{ repository: '../other', repositoryId: 10 }],
  }, secret, reader(host)), { code: 'MANAGED_CREDENTIAL_REPOSITORY_MISMATCH' });
  for (const status of [401, 403, 500]) {
    await assert.rejects(verifyManagedAuthority(host, secret, { get: async () => {
      throw Object.assign(new Error(secret), { status, code: secret });
    } }), error => !error.message.includes(secret) && error.code === (status === 401
      ? 'MANAGED_CREDENTIAL_UNAUTHORIZED' : 'MANAGED_CREDENTIAL_PROVIDER_UNAVAILABLE'));
  }
});

test('private intake, replacement, and disconnect', async t => {
  const host = await fixture(t);
  assert.equal((await manageCredentials(host, 'intake', material(), options)).status,
    'active');
  for (const path of [host.tokenFile, host.authFile, lifecyclePath(host)])
    await privateResource(path, host.uid);
  assert.equal(await readPrivate(host.tokenFile, host), secret + '\n');
  const next = decodeCredentialInput(wire('fresh_credential_123456789012345'));
  await manageCredentials(host, 'replace', next, options);
  assert.equal(await readFile(host.tokenFile, 'utf8'), next.token + '\n');
  const status = await manageCredentials(host, 'status', null, options);
  assert.equal(status.access, 'authorized');
  assert.ok(!JSON.stringify(status).includes(secret));
  assert.match(status.guidance, /logout does not revoke/);
  assert.equal((await manageCredentials(host, 'disconnect', null)).status,
    'disconnected');
  await assert.rejects(readFile(host.tokenFile), { code: 'ENOENT' });
  await assert.rejects(readFile(host.authFile), { code: 'ENOENT' });
  assert.equal((await lifecycleState(host)).phase, 'disconnected');
  assert.deepEqual(await readdir(dirname(host.tokenFile)), ['managed.json']);
});

test('manual files, symlinks and unsafe modes stay unchanged', async t => {
  const host = await fixture(t);
  await writeFile(host.tokenFile, 'manual', { mode: 0o600 });
  await assert.rejects(manageCredentials(host, 'intake', material(), options),
    { code: 'MANAGED_CREDENTIAL_FILE_CONFLICT' });
  assert.equal(await readFile(host.tokenFile, 'utf8'), 'manual');
  await rm(host.tokenFile);
  await symlink(host.authFile, host.tokenFile);
  await assert.rejects(manageCredentials(host, 'intake', material(), options),
    { code: 'MANAGED_CREDENTIAL_FILE_CONFLICT' });
  await rm(host.tokenFile);
  await chmod(dirname(host.tokenFile), 0o755);
  await assert.rejects(manageCredentials(host, 'intake', material(), options),
    { code: 'MANAGED_CREDENTIAL_PATH_UNSAFE' });
  assert.deepEqual(await readdir(dirname(host.tokenFile)), []);
});

test('denied intake and account replacement preserve files', async t => {
  const host = await fixture(t);
  const denial = { verify: async () => {
    throw Object.assign(new Error('refused'),
      { code: 'MANAGED_CREDENTIAL_MEMBER_MISMATCH' });
  } };
  await assert.rejects(manageCredentials(host, 'intake', material(), denial));
  assert.deepEqual(await readdir(dirname(host.tokenFile)), []);
  await manageCredentials(host, 'intake', material(), options);
  await assert.rejects(manageCredentials(host, 'replace', material(), denial));
  assert.equal(await readFile(host.tokenFile, 'utf8'), secret + '\n');
  assert.equal((await lifecycleState(host)).phase, 'active');
});

test('leases block replacement and disconnect until active consumers return', async t => {
  const host = await fixture(t);
  await manageCredentials(host, 'intake', material(), options);
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const waiting = new Promise(resolve => { release = resolve; });
  const consumer = consumeManagedCredentials(host, async () => {
    entered();
    await waiting;
  }, options);
  await ready;
  try {
    await assert.rejects(manageCredentials(host, 'replace', material(), options),
      { code: 'MANAGED_CREDENTIAL_CONSUMER_PENDING' });
    assert.equal((await manageCredentials(host, 'disconnect', null)).status, 'pending');
    await assert.rejects(consumeManagedCredentials(host, async () => {}, options),
      { code: 'MANAGED_CREDENTIAL_ADMISSION_DENIED' });
    assert.equal(await readFile(host.tokenFile, 'utf8'), secret + '\n');
  } finally { release(); await consumer; }
  assert.equal((await manageCredentials(host, 'disconnect', null)).status,
    'disconnected');
});

test('revocation and outage block new work but allow reconciliation', async t => {
  const host = await fixture(t);
  await manageCredentials(host, 'intake', material(), options);
  for (const code of ['MANAGED_CREDENTIAL_UNAUTHORIZED',
    'MANAGED_CREDENTIAL_PROVIDER_UNAVAILABLE']) {
    let called = false;
    const failing = { verify: async () => {
      throw Object.assign(new Error(code), { code });
    } };
    await assert.rejects(consumeManagedCredentials(host, async () => {
      called = true;
    }, failing), { code });
    assert.equal(called, false);
    const status = await manageCredentials(host, 'status', null, failing);
    assert.equal(status.access, code.endsWith('UNAVAILABLE') ? 'unavailable' :
      'unauthorized');
    assert.equal(status.status, code.endsWith('UNAVAILABLE') ? 'pending' : 'denied');
    await consumeManagedCredentials(host, async () => { called = true; },
      { ...failing, reconcile: true });
    assert.equal(called, true);
  }
});

test('unknown stage termination and journal writes keep disconnect pending', async t => {
  const host = await fixture(t);
  await manageCredentials(host, 'intake', material(), options);
  const root = join(host.stateRoot, 'issue-20-1');
  await mkdir(root, { mode: 0o700 });
  const fence = join(root, 'stage.lock');
  await writeFile(fence, '{}', { mode: 0o600 });
  await assert.rejects(managedSettlement(host),
    { code: 'MANAGED_CREDENTIAL_EFFECTS_PENDING' });
  assert.equal((await manageCredentials(host, 'disconnect')).status, 'pending');
  await rm(fence);
  const receipts = join(root, 'receipts');
  await mkdir(receipts, { mode: 0o700 });
  const journal = join(receipts, 'a'.repeat(64));
  await mkdir(journal, { mode: 0o700 });
  const payload = { pending: 'b'.repeat(64) };
  await writeFile(join(journal, 'receipts.json'),
    JSON.stringify({ payload, hash: digest(payload) }), { mode: 0o600 });
  assert.equal((await manageCredentials(host, 'disconnect')).status, 'pending');
  payload.pending = null;
  await writeFile(join(journal, 'receipts.json'),
    JSON.stringify({ payload, hash: digest(payload) }), { mode: 0o600 });
  assert.equal((await manageCredentials(host, 'disconnect')).status, 'disconnected');
});

test('lifecycle mutex rejects overlapping and abandoned transitions', async t => {
  const host = await fixture(t);
  await withCredentialLock(host, async () => {
    await assert.rejects(manageCredentials(host, 'intake', material(), options),
      { code: 'MANAGED_CREDENTIAL_CONSUMER_PENDING' });
  });
  assert.deepEqual(await readdir(dirname(host.tokenFile)), []);
});

test('uninstalled administrator entry refuses without exposing input', async () => {
  const result = await credentialAdministrator('intake', Readable.from([wire()]));
  assert.equal(result.status, 'denied');
  assert.equal(result.code, 'MANAGED_CREDENTIAL_REQUIRES_LOCAL_ADMIN');
  assert.ok(!JSON.stringify(result).includes(secret));
});

test('complete disconnect permits fresh same-member intake', async t => {
  const host = await fixture(t);
  await manageCredentials(host, 'intake', material(), options);
  await manageCredentials(host, 'disconnect');
  await manageCredentials(host, 'intake', material(), options);
  assert.equal((await lifecycleState(host)).phase, 'active');
});

test('changed credential inode, ownership and linked paths are refused', async t => {
  const host = await fixture(t);
  await manageCredentials(host, 'intake', material(), options);
  const stat = await privateResource(host.tokenFile, host.uid);
  await assert.rejects(privateResource(host.tokenFile, stat.uid + 1),
    { code: 'MANAGED_CREDENTIAL_PATH_UNSAFE' });
  await rm(host.authFile);
  await symlink(host.tokenFile, host.authFile);
  await assert.rejects(manageCredentials(host, 'replace', material(), options));
  await rm(host.authFile);
  await writeFile(host.authFile, 'unrelated', { mode: 0o600 });
  await assert.rejects(manageCredentials(host, 'disconnect'),
    { code: 'MANAGED_CREDENTIAL_FILE_CONFLICT' });
  assert.equal(await readFile(host.authFile, 'utf8'), 'unrelated');
  assert.equal(await readFile(host.tokenFile, 'utf8'), secret + '\n');
});

test('evidence objects coexist with settled native journal state', async t => {
  const host = await fixture(t);
  const root = join(host.stateRoot, 'issue-20-3');
  const receipts = join(root, 'receipts');
  await mkdir(root, { mode: 0o700 });
  await mkdir(receipts, { mode: 0o700 });
  const evidence = join(receipts, 'evidence-' + 'c'.repeat(64));
  await mkdir(evidence, { mode: 0o700 });
  await writeFile(join(evidence, 'a'.repeat(64)), '{}', { mode: 0o400 });
  await managedSettlement(host);
  await writeFile(join(evidence, 'append.lock'), '{}', { mode: 0o600 });
  await assert.rejects(managedSettlement(host),
    { code: 'MANAGED_CREDENTIAL_EFFECTS_PENDING' });
});

test('partial intake preserves a new manual conflict and removes its files', async t => {
  const host = await fixture(t);
  await assert.rejects(manageCredentials(host, 'intake', material(), {
    verify: async () => writeFile(host.authFile, 'manual conflict', { mode: 0o600 }),
  }));
  assert.equal(await readFile(host.authFile, 'utf8'), 'manual conflict');
  await assert.rejects(readFile(host.tokenFile), { code: 'ENOENT' });
  assert.deepEqual(await readdir(dirname(host.tokenFile)), ['managed.json']);
  assert.equal((await lifecycleState(host)).phase, 'installing');
});

test('a real private FIFO carries bounded credentials without argument handoff', () => {
  const script = `
    import { privateCredentialPipe, readCredentialInput } from
      './src/managed-credential-input.mjs';
    privateCredentialPipe();
    const value = await readCredentialInput(process.stdin);
    process.stdout.write(value.token.length > 20 ? 'accepted' : 'invalid');
  `;
  const result = spawnSync('/bin/sh', [
    '-c', 'cat | exec "$1" --input-type=module -e "$2"',
    'private-pipe-test', process.execPath, script,
  ], { input: wire(), encoding: 'utf8', timeout: 5000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'accepted');
  assert.ok(!result.stderr.includes(secret));
});
