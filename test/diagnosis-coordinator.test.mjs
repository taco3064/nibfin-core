import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { coordinateDiagnosis } from '../src/diagnosis-coordinator.mjs';
import { prepareDiagnosisInvocation } from '../src/diagnosis-invocation.mjs';
import { diagnosisToolDenial } from '../src/diagnosis-tool-denial.mjs';
import { command } from '../src/process.mjs';
import { providerHost } from './provider-fixture.mjs';

async function using(run) {
  const root = await mkdtemp(join(tmpdir(), 'diagnosis-test-'));
  try {
    await run({ host: { uid: process.getuid(), stateRoot: root,
      confirm: async () => {} }, subject: { id: 5 },
    issue: { repository: 'example/project', repositoryId: 2, number: 7,
      id: 'I_target' }, attempt: { stage: 'deliver',
      id: '12345678-1234-1234-1234-123456789012' },
    evidenceId: 'a'.repeat(64), evidence: [{ reference: 'report:' + 'a'.repeat(64) }] });
  } finally { await rm(root, { recursive: true, force: true }); }
}
const report = { explanation: 'The retained exit has an unknown cause.',
  hypotheses: [], missing: ['Guest telemetry is unavailable.'] };

test('identical concurrent requests and distinct requests start one invocation',
  async () => using(async input => {
    let calls = 0, finish, entered;
    const started = new Promise(resolve => { entered = resolve; });
    const prepare = async () => async () => {
      calls++; entered();
      return new Promise(resolve => { finish = () => resolve({
        terminated: true, report }); });
    };
    const first = coordinateDiagnosis(input, { prepare });
    await started;
    const duplicate = await coordinateDiagnosis(input, { prepare });
    assert.equal(duplicate.status, 'unresolved-effect');
    const other = await coordinateDiagnosis({ ...input,
      evidenceId: 'b'.repeat(64) }, { prepare });
    assert.equal(other.status, 'no-capacity');
    assert.equal(calls, 1);
    finish();
    const result = await first;
    assert.equal(result.status, 'reported');
    assert.equal(result.report.executionAuthority, false);
    assert.equal((await coordinateDiagnosis(input, { prepare })).status, 'reported');
    assert.equal(calls, 1);
    const files = await readdir(join(input.host.stateRoot, 'diagnoses'));
    assert.equal(files.length, 1);
  }));

test('unknown termination never expires into a duplicate invocation', async () =>
  using(async input => {
    let calls = 0;
    const prepare = async () => async () => { calls++; throw new Error('Lost'); };
    assert.equal((await coordinateDiagnosis(input, { prepare })).status,
      'unresolved-effect');
    assert.equal((await coordinateDiagnosis(input, { prepare })).status,
      'unresolved-effect');
    assert.equal(calls, 1);
    assert.ok((await readdir(join(input.host.stateRoot, 'diagnoses')))
      .includes('active.lock'));
  }));

test('composed installed invocation returns a report and removes completed mounts',
  async () => using(async input => {
    const adopted = providerHost();
    adopted.uid = process.getuid();
    adopted.repository.isolation.namespace = {
      uidStart: 131072, gidStart: 131072, size: 65536 };
    input.host.diagnosisHost = adopted;
    let calls = 0;
    const prepare = (host, issue) => prepareDiagnosisInvocation(host, issue, {
      verify: async () => {}, socket: async () => {},
      read: async path => path.endsWith('result.json') ? JSON.stringify(report)
        : JSON.stringify({ auth_mode: 'chatgpt', tokens: {
          access_token: 'a'.repeat(25), refresh_token: 'b'.repeat(25),
          id_token: 'c'.repeat(25) } }),
      environment: async () => ({ agent: {
        preflight: async () => {},
        execute: async options => {
          calls++;
          assert.equal(options.plan.contract.kind, 'read-only-diagnosis-v1');
          assert.equal(options.plan.writable, false);
          assert.equal(options.plan.mcpPolicyHash, null);
          assert.equal(options.plan.timeout, 120000);
          assert.equal(options.plan.config['permissions.nibfin.network.enabled'], false);
          assert.equal(options.jobVmSocket, undefined);
          assert.equal(options.plan.config['permissions.nibfin.filesystem']['/work'],
            'deny');
          assert.deepEqual(await readdir(options.work), []);
          assert.deepEqual(await readdir(options.main), []);
          return { status: 'completed', executionId: options.executionId,
            terminationHash: 'd'.repeat(64) };
        },
      } }),
    });
    const result = await coordinateDiagnosis(input, { prepare });
    assert.equal(result.status, 'reported');
    assert.equal(result.report.confidence, 'attributed');
    assert.equal(result.report.explanation, report.explanation);
    assert.equal(calls, 1);
    assert.equal((await readdir(join(input.host.stateRoot, 'diagnoses'))).length, 1);
  }));

test('diagnosis external environment rejects every executable and mutation method',
  async () => {
    const requests = ['initialize', 'exec', 'shell', 'apply_patch', 'build',
      'workflow_dispatch', 'readFile'].map((method, id) =>
      JSON.stringify({ jsonrpc: '2.0', id, method,
        params: { command: 'touch /work/forbidden' } })).join('\n') + '\n';
    const result = await command(process.execPath, ['-e', diagnosisToolDenial],
      { input: requests, timeout: 5000 });
    const replies = result.stdout.toString().trim().split('\n').map(JSON.parse);
    assert.equal(replies.length, 7);
    assert.equal(replies[0].result.sessionId, 'diagnosis');
    for (const reply of replies.slice(1))
      assert.equal(reply.error.message, 'DIAGNOSIS_TOOLS_DENIED');
  });

test('cached result remains readable when provider capacity later disappears',
  async () => using(async input => {
    const prepare = async () => async () => ({ terminated: true, report });
    assert.equal((await coordinateDiagnosis(input, { prepare })).status, 'reported');
    const unavailable = async () => { throw new Error('Provider unavailable'); };
    assert.equal((await coordinateDiagnosis(input, { prepare: unavailable })).status,
      'reported');
  }));

test('unavailable capacity before invocation retires only diagnostic claims',
  async () => using(async input => {
    const result = await coordinateDiagnosis(input, {
      prepare: async () => { throw new Error('No adopted sandbox'); },
    });
    assert.equal(result.status, 'no-capacity');
    assert.deepEqual(await readdir(join(input.host.stateRoot, 'diagnoses')), []);
  }));
