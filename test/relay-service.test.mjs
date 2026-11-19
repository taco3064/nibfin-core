import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, readdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeRelayResource } from '../src/relay-service.mjs';
import { validateRelayConfiguration, bindRelayOrigin } from '../src/relay-host.mjs';
import { includesPackagePath } from '../src/source-package.mjs';
import { relayFixture, origin, coreCommit } from './relay-fixture.mjs';
import { withRelayGate } from '../src/relay-state.mjs';
import { providerHost } from './provider-fixture.mjs';

const configuration = () => ({ schemaVersion: 1, origins: [structuredClone(origin)] });

test('fixed configuration rejects unbounded, untrusted or ambiguous identities', () => {
  assert.deepEqual(validateRelayConfiguration(configuration()), configuration());
  for (const change of [
    value => { value.tokenFile = '/tmp/token'; },
    value => { value.origins.push(value.origins[0]); },
    value => { value.origins[0].workflow.id = '20'; },
    value => { value.origins[0].workflow.path = '../../script'; },
    value => { value.origins[0].workflow.commit = 'main'; },
    value => { value.origins = []; },
    value => { value.origins[0].credential = 'secret'; },
  ]) {
    const value = configuration(); change(value);
    assert.throws(() => validateRelayConfiguration(value), /INVALID_RELAY_CONFIGURATION/);
  }
});

test('adopted event/source/destination bindings cannot be replaced by config', () => {
  const provider = providerHost();
  const host = { ...provider, uid: 1000, memberId: 4, stateRoot: '/private',
    installation: { pin: { ...provider.installation.pin, commit: coreCommit } },
    repository: { ...provider.repository,
      runner: { repositoryId: 5, runnerId: 10 } },
    sharedRunner: { runner: { repository: 'owner/execution', repositoryId: 5,
      workflowId: 50, workflowPath: '.github/workflows/shared-runner.yml',
      jobName: 'shared-stage', runnerId: 10, runnerName: 'slot-1', memberId: 4 },
    caller: { repository: 'owner/execution', repositoryId: 5 }, repositories: [1] } };
  const target = { ...host, repository: { approval: { repository: origin.repository,
    repositoryId: origin.repositoryId }, eventRunner: { repository: origin.repository,
      repositoryId: 1, workflowId: 20, workflowPath: origin.workflow.path,
      sourceCommit: origin.workflow.commit, workflowBlob: origin.workflow.blob,
      reusable: { repository: 'taco3064/nibfin-core', path: '.github/workflows/issue.yml',
        commit: coreCommit } } } };
  assert.equal(bindRelayOrigin(host, target, origin).repositoryId, 5);
  for (const change of [
    value => { value.uid = 2000; },
    value => { value.memberId = 99; },
    value => { value.repository.eventRunner.workflowId = 99; },
    value => { value.repository.eventRunner.workflowBlob = 'f'.repeat(40); },
    value => { value.repository.approval.repositoryId = 9; },
  ]) {
    const altered = structuredClone(target); change(altered);
    assert.throws(() => bindRelayOrigin(host, altered, origin),
      /RELAY_ORIGIN_NOT_ADOPTED/);
  }
});

test('service resources prepare idempotently and preserve/reject conflicting state',
  async t => {
    const root = await mkdtemp(join(tmpdir(), 'relay-service-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const inspect = async () => {};
    assert.equal(await writeRelayResource(root, 'relay.service', 'unit\n', inspect),
      'prepared');
    assert.equal(await writeRelayResource(root, 'relay.service', 'unit\n', inspect),
      'unchanged');
    await assert.rejects(writeRelayResource(root, 'relay.service', 'changed', inspect),
      /RELAY_RESOURCE_CONFLICT/);
    assert.equal(await readFile(join(root, 'relay.service'), 'utf8'), 'unit\n');
    await writeFile(join(root, 'other'), 'unit\n');
    await symlink(join(root, 'other'), join(root, 'symlink.service'));
    await assert.rejects(writeRelayResource(root, 'symlink.service', 'unit\n', inspect));
    assert.deepEqual((await readdir(root)).sort(),
      ['other', 'relay.service', 'symlink.service']);
  });

test('packaged timer/service use a fixed command outside Runner slots', async () => {
  for (const name of ['nibfin-notification-relay.service',
    'nibfin-notification-relay.timer']) {
    const path = 'src/security/' + name;
    assert.equal(includesPackagePath(path), true);
    const content = await readFile(path, 'utf8');
    assert.doesNotMatch(content, /Listen|runner@|slot-[12]|Docker/);
    if (name.endsWith('.service')) {
      assert.match(content, /bin\/nibfin-notification-relay.mjs poll/);
      assert.match(content, /ReadWritePaths=\/var\/lib\/nibfin\/notification-relay/);
    } else assert.match(content, /OnUnitInactiveSec=60s/);
  }
});

test('abruptly terminated lock holder releases the kernel gate on restart', async t => {
  const fixture = await relayFixture(t);
  const modulePath = fileURLToPath(new URL('../src/relay-state.mjs', import.meta.url));
  const script = `import {withRelayGate} from ${JSON.stringify(modulePath)};\n` +
    `await withRelayGate(${JSON.stringify(fixture.root)}, async () => {\n` +
    // A live listener retains the resolver and the suspended lock scope. An
    // unreachable, never-resolving promise lets GC close the lock's FileHandle.
    'const disconnected = new Promise(resolve => ' +
    'process.once("disconnect", resolve));\n' +
    'setImmediate(() => { global.gc(); process.send("ready"); });\n' +
    'await disconnected; });';
  const child = spawn(process.execPath,
    ['--expose-gc', '--input-type=module', '-e', script],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const closed = new Promise(resolve => child.once('close', resolve));
  try {
    const ready = await new Promise((resolve, reject) => {
      child.once('message', resolve); child.once('error', reject);
      child.once('exit', () => reject(new Error('holder exited before readiness')));
    });
    assert.equal(ready, 'ready');
    const concurrent = await withRelayGate(fixture.root, () => 'impossible');
    assert.equal(concurrent.code, 'RELAY_BUSY');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
  }
  assert.equal(await withRelayGate(fixture.root, () => 'recovered'), 'recovered');
});

test('receiving host accepts exact managed and legacy recipes after a rerun', async t => {
  const { observeIssueEvent } = await import('../src/issue-wake.mjs');
  const { RelayReader } = await import('../src/relay-http.mjs');
  for (const callerKind of ['issue', 'issue-managed']) {
    const fixture = await relayFixture(t, { callerKind, latestAttempt: 2 });
    const reader = new RelayReader('fake-controller-token', fixture.fetcher);
    const issue = await observeIssueEvent(reader, { schemaVersion: 1, coreCommit,
      eventWorkflow: origin.workflow, issues: [],
      repository: { approvalPin: { kind: 'repository-admission-v1' } },
    }, (await import('./relay-fixture.mjs')).wakeEvent(), {
      coreCommit, eventName: 'issues', attempt: 1, runId: 30,
      repository: origin.repository, forwarded: true,
    });
    assert.equal(issue.id, 'I_example');
  }
});


test('fixed installed entry rejects extra inputs and non-installed invocation', () => {
  for (const [args, code] of [
    [['poll', '/tmp/config'], 'INVALID_RELAY_COMMAND'],
    [['arbitrary'], 'INVALID_RELAY_COMMAND'],
    [['poll'], 'RELAY_REQUIRES_INSTALLED_ADMINISTRATOR'],
  ]) {
    const child = spawnSync(process.execPath,
      ['bin/nibfin-notification-relay.mjs', ...args], { encoding: 'utf8' });
    assert.equal(child.status, 1);
    assert.equal(JSON.parse(child.stderr).code, code);
  }
});
