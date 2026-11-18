import test from 'node:test';
import assert from 'node:assert/strict';
import { collectDiagnosis, validateDiagnosisRequest }
  from '../src/diagnosis-request.mjs';
import { makeBlockerReport, projectBlockerReport } from '../src/blocker-report.mjs';
import { fixture, identity, issue } from './local-work-fixture.mjs';

function setup() {
  const f = fixture();
  f.context.runner.repository = 'example/pool';
  const report = makeBlockerReport(f.context, 'deliver', { producer: 'core-native',
    code: 'PROCESS_FAILED' });
  const reports = [{ report, projected: projectBlockerReport(report,
    { issue: identity, subjectId: 5 }) }];
  const request = { token: 'private', repository: identity.repository,
    issueNumber: 7, attempt: { id: f.context.execution.id, stage: 'deliver' },
    diagnose: true };
  const dependencies = { reader: f.reader, discover: f.discover,
    reportsFactory: () => ({ reports: async () => reports, confirm: async () => {} }) };
  return { f, reports, request, dependencies };
}

test('selected closed historical issue does not depend on the live collector',
  async () => {
    const { f, request, dependencies } = setup();
    const original = f.reader.get;
    dependencies.reader = { async get(path) {
      const value = await original(path);
      return path.endsWith('/issues/7') ? { ...value, state: 'closed' } : value;
    } };
    let invoked = 0;
    dependencies.coordinate = async input => {
      invoked++;
      assert.equal(input.evidence[0].code, 'PROCESS_FAILED');
      assert.equal(input.evidence[0].rootCause, null);
      assert.equal(input.issue.id, identity.id);
      return { status: 'reported' };
    };
    assert.equal((await collectDiagnosis(request, dependencies)).status, 'reported');
    assert.equal(invoked, 1);
    assert.ok(!f.calls.some(path => path.includes('issues?') || path.includes('runs?')));
  });

test('read request never acquires diagnosis capacity', async () => {
  const { request, dependencies } = setup();
  dependencies.coordinate = () => { throw new Error('Unexpected invocation'); };
  const result = await collectDiagnosis({ ...request, diagnose: false }, dependencies);
  assert.equal(result.status, 'reported');
  assert.equal(result.reports[0].current, false);
  assert.equal(result.executionAuthority, false);
});

test('authentication and subject authorization precede evidence and work', async () => {
  const { request, dependencies } = setup();
  let reads = 0, invokes = 0;
  dependencies.reportsFactory = () => { reads++; throw new Error('No read'); };
  dependencies.coordinate = () => { invokes++; };
  const original = dependencies.reader.get;
  dependencies.reader = { async get(path) {
    if (path.endsWith('/issues/7')) return { ...issue, assignees: [{ id: 8 }] };
    return original(path);
  } };
  assert.equal((await collectDiagnosis(request, dependencies)).status, 'denied');
  assert.equal(reads, 0); assert.equal(invokes, 0);
  dependencies.reader = { get: async () => { throw new Error('Unauthenticated'); } };
  assert.equal((await collectDiagnosis(request, dependencies)).code,
    'AUTHENTICATION_DENIED');
  assert.equal(reads, 0);
});

test('changed evidence and foreign native jobs deny invocation', async () => {
  const { request, dependencies } = setup();
  const original = dependencies.reader.get;
  let invoked = 0;
  dependencies.coordinate = () => { invoked++; };
  dependencies.reader = { async get(path) {
    const value = await original(path);
    return path.endsWith('/jobs/200') ? { ...value, run_attempt: 2 } : value;
  } };
  assert.equal((await collectDiagnosis(request, dependencies)).status, 'denied');
  assert.equal(invoked, 0);
});

test('request rejects paths, provider selection and implicit execution', () => {
  const { request } = setup();
  for (const changes of [{ path: '/etc/passwd' }, { model: 'chosen' },
    { diagnose: undefined }, { repository: '../private' },
    { attempt: { id: '/tmp/evidence', stage: 'deliver' } }])
    assert.throws(() => validateDiagnosisRequest({ ...request, ...changes }));
});

test('absent native job evidence remains a gap without requiring an online Runner',
  async () => {
    const { request, dependencies } = setup();
    const original = dependencies.reader.get;
    dependencies.reader = { async get(path) {
      if (path.endsWith('/jobs/200'))
        throw Object.assign(new Error('Unavailable'), { status: 404 });
      return original(path);
    } };
    let called = false;
    dependencies.coordinate = async input => {
      called = true;
      assert.ok(input.evidence[0].missing.includes('NATIVE_JOB_EVIDENCE_UNAVAILABLE'));
      return { status: 'reported' };
    };
    assert.equal((await collectDiagnosis(request, dependencies)).status, 'reported');
    assert.equal(called, true);
  });
