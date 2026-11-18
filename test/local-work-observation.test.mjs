import test from 'node:test';
import assert from 'node:assert/strict';
import { collectLocalWork } from '../src/local-work-observation.mjs';
import { discoverLocalHost } from '../src/local-work-host.mjs';
import { observation, limits } from '../src/local-work-values.mjs';
import { digest } from '../src/identity.mjs';
import { createProviderBinding } from '../src/provider-binding.mjs';
import { fixture, adopted, subject, at } from './local-work-fixture.mjs';

const collect = input => collectLocalWork('test-private-token', input);
for (const count of [0, 1, 2, 4]) {
  test(`observation preserves ${count} registrations without a slot limit`, async () => {
    const input = fixture(count);
    const result = await collect(input);
    assert.equal(result.runners.length, count);
    assert.equal(result.completeness, 'complete');
    assert.ok(result.runners.every(runner => runner.state === 'idle'));
    assert.equal(result.work[0].activity.value, null);
    assert.equal(result.work[0].waiting.value, 'no-admission-observed');
  });
}
test('authentication failure returns no local or foreign data', async () => {
  const input = fixture();
  input.reader.get = async () => { throw new Error('private error'); };
  input.discover = assert.fail;
  assert.deepEqual(await collect(input), {
    schemaVersion: 1, status: 'denied', code: 'AUTHENTICATION_DENIED',
  });
});
test('native busy without a qualified Issue retains unknown association', async () => {
  const input = fixture(); input.executing();
  const result = await collect(input);
  assert.equal(result.runners[0].state, 'busy');
  assert.equal(result.work.find(work => work.native)?.issue, null);
  assert.equal(result.work.find(work => work.native)?.phase.value, null);
});
test('a matched job exposes Issue identity but retained context does not prove phase',
  async () => {
    const input = fixture(); input.executing();
    input.local.contexts.push({ context: input.context });
    const result = await collect(input);
    assert.equal(result.work[0].issue.id, 'I_target');
    assert.equal(result.work[0].native.jobId, 200);
    assert.equal(result.work[0].phase.value, null);
    assert.equal(result.work[0].activity.value, 'executing');
  });
test('unique live phase evidence is confirmed across the interval', async () => {
  const input = fixture(); input.executing();
  input.local.contexts.push({ context: input.context });
  let confirmations = 0;
  input.evidenceFactory = () => ({ issue: async () => input.local,
    phase: async () => ({ stage: 'accept', confirm: async () => confirmations++ }),
    confirm: async () => {} });
  const result = await collect(input);
  assert.equal(result.work[0].phase.value, 'accept');
  assert.equal(confirmations, 1);
});
for (const changed of ['attempt', 'runner', 'actor', 'source']) {
  test(`conflicting ${changed} does not associate a context`, async () => {
    const input = fixture(); input.executing();
    input.local.contexts.push({ context: input.context });
    if (changed === 'attempt') input.context.execution.attempt = 2;
    if (changed === 'runner') input.context.runner.runnerId = 999;
    if (changed === 'actor') input.run.actor = { id: 999 };
    if (changed === 'source') input.context.runner.sourceCommit = 'b'.repeat(40);
    const result = await collect(input);
    assert.equal(result.work.find(work => work.native)?.issue, null);
  });
}
test('offline and missing native permission remain distinct', async () => {
  const input = fixture(2); input.offline();
  const get = input.reader.get;
  input.reader.get = async path => {
    if (path.endsWith('/runners/43')) throw Object.assign(new Error(), { status: 403 });
    return get(path);
  };
  const result = await collect(input);
  assert.equal(result.runners[0].state, 'offline');
  assert.equal(result.runners[1].state, 'unknown');
  assert.equal(result.completeness, 'partial');
  assert.ok(result.errors.includes('ACCESS_OR_RATE_LIMIT'));
});
test('incomplete discovery cannot establish idle', async () => {
  const input = fixture(); const get = input.reader.get;
  input.reader.get = async path => {
    if (path.includes('/runs?')) throw Object.assign(new Error(), { status: 403 });
    return get(path);
  };
  const result = await collect(input);
  assert.equal(result.runners[0].state, 'unknown');
  assert.equal(result.completeness, 'partial');
});
test('changing native reads invalidate association and idle assertions', async () => {
  const input = fixture(); const get = input.reader.get; let count = 0;
  input.reader.get = async path => {
    const value = await get(path);
    if (path.endsWith('/runners/42') && ++count > 1) value.busy = true;
    return value;
  };
  const result = await collect(input);
  assert.equal(result.runners[0].state, 'unknown');
  assert.ok(result.errors.includes('OBSERVATION_CHANGED'));
});
test('pause, dependency and unresolved effect remain separate dimensions', async () => {
  const input = fixture();
  const event = { id: 1, event: 'labeled', created_at: at,
    label: { name: 'pause' }, actor: subject };
  input.local.wake.decisions.push({ eventHash: digest(event),
    qualification: 'allowed', desired: true, observationHash: 'a'.repeat(64) });
  input.local.journal.pending = true;
  const get = input.reader.get;
  input.reader.get = async path => {
    if (path.includes('/events?')) return [event];
    if (path.includes('/blocked_by?')) return [{ state: 'open', labels: [],
      repository_url: 'https://api.github.com/repos/example/project' }];
    const value = await get(path);
    if (path.endsWith('/issues/7')) value.labels.push({ name: 'pause' });
    return value;
  };
  const result = await collect(input);
  const work = result.work[0];
  assert.equal(work.pause.value, true);
  assert.equal(work.dependencies.value, 1);
  assert.equal(work.executionBlocker.code, 'EXTERNAL_EFFECT_UNKNOWN');
  assert.equal(work.waiting.value, null);
});
test('missing timestamps remain unknown and old/future timestamps are stale', () => {
  assert.equal(observation(true, 'native', at).freshness, 'unknown');
  assert.equal(observation(true, 'native', at, at).freshness, 'fresh');
  const before = new Date(Date.parse(at) - limits.freshMilliseconds - 1).toISOString();
  assert.equal(observation(true, 'native', at, before).freshness, 'stale');
  assert.equal(observation(true, 'native', at, '2099-01-01').freshness, 'stale');
});
test('fixed adoption discovery deduplicates registration routes', async () => {
  const primary = adopted();
  primary.wakePeerFiles = ['/etc/nibfin/host.project.json'];
  primary.sharedRunner.repositories.push(2);
  const peer = structuredClone(primary);
  peer.repository.approval.repositoryId = 2;
  peer.repository.runner = { ...peer.repository.runner,
    repository: 'example/project', repositoryId: 2 };
  const read = async path => ({ bytes: JSON.stringify(path.endsWith('host.json')
    ? primary : peer), sourceTime: at });
  const result = await discoverLocalHost(subject, read);
  assert.equal(result.bindings.length, 2);
  assert.equal(result.bindings[0].routes.length, 2);
  await result.confirm();
});
for (const explicit of [false, true]) {
  test(`peer extends observation beyond two, explicit=${explicit}`, async () => {
    const primary = adopted();
    primary.wakePeerFiles = ['/etc/nibfin/host.other.json'];
    const peer = structuredClone(primary);
    peer.sharedRunner.runner.runnerId = 80;
    peer.sharedRunner.runner.runnerName = 'another';
    delete peer.sharedRunner.additionalRunner;
    if (explicit) {
      primary.providerBinding = createProviderBinding(primary);
      peer.providerBinding = createProviderBinding(peer);
    }
    const read = async path => ({ bytes: JSON.stringify(path.endsWith('host.json')
      ? primary : peer), sourceTime: at });
    const result = await discoverLocalHost(subject, read);
    assert.deepEqual(result.bindings.map(item => item.expected.runnerId),
      [42, 43, 80]);
    assert.deepEqual(result.errors, []);
    await result.confirm();
    if (explicit) {
      peer.providerBinding.original.pool.runners[0].id = 81;
      const invalid = await discoverLocalHost(subject, read);
      assert.equal(invalid.bindings.length, 2);
      assert.ok(invalid.errors.length > 0);
    }
  });
}
test('explicit legacy secondary view retains primary pool validation', async () => {
  const primary = adopted();
  primary.providerBinding = createProviderBinding(primary);
  primary.wakePeerFiles = ['/etc/nibfin/host.secondary.json'];
  const peer = structuredClone(primary);
  peer.runnerUid = primary.sharedRunner.additionalRunner.uid;
  peer.sharedRunner.runner = { ...primary.sharedRunner.runner,
    runnerId: primary.sharedRunner.additionalRunner.id,
    runnerName: primary.sharedRunner.additionalRunner.name };
  delete peer.sharedRunner.additionalRunner;
  const read = async path => ({ bytes: JSON.stringify(path.endsWith('host.json')
    ? primary : peer), sourceTime: at });
  const result = await discoverLocalHost(subject, read);
  assert.deepEqual(result.bindings.map(item => item.expected.runnerId), [42, 43]);
  assert.deepEqual(result.errors, []);
  peer.sharedRunner.runner.runnerName = 'unverified';
  const invalid = await discoverLocalHost(subject, read);
  assert.ok(invalid.errors.length > 0);
});
test('foreign peer member and caller-selected peer paths do not grant observation',
  async () => {
    const primary = adopted();
    primary.wakePeerFiles = ['/etc/nibfin/host.foreign.json'];
    const peer = structuredClone(primary); peer.memberId = 99;
    const read = async path => ({ bytes: JSON.stringify(path.endsWith('host.json')
      ? primary : peer), sourceTime: at });
    const result = await discoverLocalHost(subject, read);
    assert.equal(result.bindings.length, 2);
    assert.ok(result.errors.includes('SUBJECT_MISMATCH'));
    primary.wakePeerFiles = ['/tmp/untrusted.json'];
    await assert.rejects(discoverLocalHost(subject, read));
    await assert.rejects(discoverLocalHost({ id: 99 }, read),
      { code: 'SUBJECT_MISMATCH' });
  });
test('queued and dispatched work remain distinct', async () => {
  const input = fixture(); input.executing();
  input.job.status = 'queued'; input.job.runner_id = 0; input.job.runner_name = null;
  input.local.wake.dispatchRunId = 100;
  const result = await collect(input);
  assert.equal(result.work[0].activity.value, 'queued');
  assert.equal(result.work[0].phase.value, null);
  assert.equal(result.work[0].native.runId, 100);
  const dispatched = fixture(); dispatched.local.wake.dispatchRunId = 101;
  dispatched.local.wake.pending = true;
  const observed = await collect(dispatched);
  assert.equal(observed.work[0].activity.value, 'dispatched');
  assert.equal(observed.work[0].executionBlocker.code, 'EXTERNAL_EFFECT_UNKNOWN');
  assert.equal(observed.work[0].waiting.value, null);
});
for (const status of ['in_progress', 'queued']) {
  for (const actorId of [5, 999]) {
    test(`unrelated ${status} job by ${actorId} cannot suppress waiting`, async () => {
      const input = fixture(); input.executing();
      input.job.status = status;
      input.job.runner_id = status === 'queued' ? 0 : 999;
      input.job.runner_name = status === 'queued' ? null : 'runner-0';
      input.run.actor = { id: actorId };
      input.run.triggering_actor = { id: actorId };
      const get = input.reader.get;
      input.reader.get = async path => {
        const value = await get(path);
        if (path.endsWith('/runners/42')) value.busy = false;
        return value;
      };
      const result = await collect(input);
      assert.equal(result.work.length, 1);
      assert.equal(result.work[0].native, null);
      assert.equal(result.work[0].activity.value, null);
      assert.equal(result.work[0].waiting.value, 'no-admission-observed');
      assert.equal(result.runners[0].state, 'idle');
      assert.equal(result.completeness, 'complete');
      assert.ok(!JSON.stringify(result).includes('/job/200'));
    });
  }
}
test('foreign dispatch actor cannot qualify an unassigned queued job', async () => {
  const input = fixture(); input.executing();
  input.job.status = 'queued'; input.job.runner_id = 0; input.job.runner_name = null;
  input.local.wake.dispatchRunId = 100;
  input.run.actor = { id: 999 }; input.run.triggering_actor = { id: 999 };
  const result = await collect(input);
  assert.equal(result.work.some(work => work.native), false);
  assert.equal(result.work[0].activity.value, 'dispatched');
});
test('unverified native registration cannot authorize job projection', async () => {
  const input = fixture(); input.executing();
  const get = input.reader.get;
  input.reader.get = async path => {
    if (path.endsWith('/runners/42')) throw Object.assign(new Error(), { status: 403 });
    return get(path);
  };
  const result = await collect(input);
  assert.equal(result.work.some(work => work.native), false);
  assert.equal(result.work[0].waiting.value, null);
  assert.equal(result.completeness, 'partial');
});
test('unqualified pause label cannot confirm pause or ordinary waiting', async () => {
  const input = fixture(); const get = input.reader.get;
  input.reader.get = async path => {
    const value = await get(path);
    if (path.endsWith('/issues/7')) value.labels.push({ name: 'pause' });
    return value;
  };
  const result = await collect(input);
  assert.equal(result.work[0].pause.value, null);
  assert.equal(result.work[0].waiting.value, null);
  assert.equal(result.completeness, 'partial');
});
test('reused names with a different Runner ID do not bind work', async () => {
  const input = fixture(); input.executing();
  input.job.runner_id = 900;
  input.local.contexts.push({ context: input.context });
  const result = await collect(input);
  assert.equal(result.work.some(work => work.native), false);
  assert.equal(result.runners[0].association.value, null);
});
test('unsafe native job URL is withheld and cannot establish idle', async () => {
  const input = fixture(); input.executing();
  input.job.html_url = 'https://secret.blob.core.windows.net/log?token=private';
  const result = await collect(input);
  assert.equal(result.work.some(work => work.native), false);
  assert.equal(result.runners[0].association.value, null);
  assert.equal(result.completeness, 'partial');
  assert.ok(!JSON.stringify(result).includes('token='));
});
for (const resource of ['run', 'job']) {
  test(`contradictory ${resource} detail ID cannot establish association`, async () => {
    const input = fixture(); input.executing();
    input.local.contexts.push({ context: input.context });
    const get = input.reader.get;
    input.reader.get = async path => {
      const value = await get(path);
      if (resource === 'run' && path.endsWith('/runs/100')) value.id = 101;
      if (resource === 'run' && path.includes('/attempts/')) {
        for (const job of value.jobs) {
          job.run_id = 101;
          job.html_url = job.html_url.replace('/runs/100/', '/runs/101/');
        }
      }
      if (resource === 'run' && path.endsWith('/jobs/200')) {
        value.run_id = 101;
        value.html_url = value.html_url.replace('/runs/100/', '/runs/101/');
      }
      if (resource === 'job' && path.endsWith('/jobs/200')) {
        value.id = 201;
        value.html_url = value.html_url.replace('/job/200', '/job/201');
      }
      return value;
    };
    const result = await collect(input);
    assert.equal(result.runners[0].association.value, null);
    assert.equal(result.work.some(work => work.native), false);
    assert.equal(result.work[0].waiting.value, null);
    assert.equal(result.completeness, 'partial');
    assert.ok(result.errors.includes('UNVERIFIED_BINDING'));
  });
}
test('contradictory live phase proofs remain unknown', async () => {
  const input = fixture(); input.executing();
  input.local.contexts.push({ context: input.context },
    { context: structuredClone(input.context) });
  input.evidenceFactory = () => ({ issue: async () => input.local,
    phase: async () => ({ stage: 'deliver', confirm: async () => {} }),
    confirm: async () => {} });
  const result = await collect(input);
  assert.equal(result.work[0].phase.value, null);
});
test('changed trusted adoption clears previously verified state assertions', async () => {
  const input = fixture(); input.executing();
  input.local.contexts.push({ context: input.context });
  input.host.confirm = async () => {
    throw Object.assign(new Error('private-path-token'), { code: 'OBSERVATION_CHANGED' });
  };
  const result = await collect(input);
  assert.equal(result.runners[0].association.value, null);
  assert.equal(result.work[0].activity.value, null);
  assert.ok(!JSON.stringify(result).includes('private-path-token'));
});
test('bounded list exhaustion cannot establish idle', async () => {
  const input = fixture(); const get = input.reader.get;
  input.reader.get = async path => {
    if (path.includes('/runs?')) return { total_count: 1000,
      workflow_runs: Array.from({ length: 100 }, () => ({ id: 100 })) };
    return get(path);
  };
  const result = await collect(input);
  assert.equal(result.runners[0].state, 'unknown');
  assert.ok(result.errors.includes('OBSERVATION_LIMIT'));
});
test('private context contents never appear in the consumer response', async () => {
  const input = fixture(); input.executing();
  input.context.token = 'should-remain-private';
  input.context.host = { tokenFile: '/private/credential-path' };
  input.local.contexts.push({ context: input.context });
  const result = await collect(input);
  const bytes = JSON.stringify(result);
  assert.ok(!bytes.includes('should-remain-private'));
  assert.ok(!bytes.includes('credential-path'));
  assert.ok(!bytes.includes('/never-read'));
});
test('offline registration cannot corroborate an active job', async () => {
  const input = fixture(); input.executing(); input.offline();
  input.local.contexts.push({ context: input.context });
  const result = await collect(input);
  assert.equal(result.work.find(work => work.native)?.issue, null);
  assert.equal(result.runners[0].association.value, null);
  assert.equal(result.work[0].waiting.value, null);
});
test('subject changes return denial without prior data', async () => {
  const input = fixture(); const get = input.reader.get; let reads = 0;
  input.reader.get = async path => {
    if (path === '/user' && ++reads > 1) return { ...subject, id: 999 };
    return get(path);
  };
  assert.deepEqual(await collect(input), {
    schemaVersion: 1, status: 'denied', code: 'AUTHENTICATION_DENIED',
  });
});

test('confirmed dispatch without a pending effect cannot assert ordinary waiting',
  async () => {
    const input = fixture(); input.local.wake.dispatchRunId = 101;
    const result = await collect(input);
    assert.equal(result.work[0].activity.value, 'dispatched');
    assert.equal(result.work[0].waiting.value, null);
  });
test('completed dispatch does not imply a current job without native evidence',
  async () => {
    const input = fixture(); input.local.wake.dispatchRunIds = [100];
    const result = await collect(input);
    assert.equal(result.work[0].native, null);
    assert.equal(result.work[0].activity.value, null);
    assert.equal(result.work[0].waiting.value, 'no-admission-observed');
  });

for (const status of ['queued', 'requested', 'in_progress']) {
  for (const hasJobs of [false, true]) {
    test(`completed dispatch retains ${status} run, jobs=${hasJobs}`, async () => {
      const input = fixture(); input.executing();
      input.run.status = status;
      input.job.status = 'queued';
      input.job.runner_id = 0; input.job.runner_name = null;
      input.local.wake.dispatchRunIds = [100];
      const get = input.reader.get;
      input.reader.get = async path => {
        if (path.includes('/runs?')) {
          const runs = path.includes(`status=${status}&`) ? [input.run] : [];
          return { workflow_runs: runs, total_count: runs.length };
        }
        if (!hasJobs && path.includes('/attempts/'))
          return { jobs: [], total_count: 0 };
        return get(path);
      };
      const result = await collect(input);
      const work = result.work[0];
      assert.equal(work.activity.value, hasJobs ? 'queued' : 'dispatched');
      assert.equal(work.waiting.value, null);
      assert.equal(work.phase.value, null);
      assert.equal(work.native?.jobId ?? null, hasJobs ? 200 : null);
      assert.equal(work.executionBlocker.code, 'NO_PENDING_EFFECT');
    });
  }
}

for (const conflict of ['actor', 'route', 'run', 'interval']) {
  test(`jobless dispatch rejects conflicting ${conflict}`, async () => {
    const input = fixture(); input.executing();
    input.local.wake.dispatchRunIds = [conflict === 'run' ? 101 : 100];
    if (conflict === 'actor') input.run.actor = { id: 999 };
    if (conflict === 'route') input.host.bindings[0].routes = [];
    const get = input.reader.get;
    let reads = 0;
    input.reader.get = async path => {
      if (path.includes('/attempts/')) return { jobs: [], total_count: 0 };
      const value = await get(path);
      if (path.endsWith('/runners/42')) value.busy = false;
      if (path.endsWith('/runs/100') && conflict === 'interval' && ++reads > 1)
        value.status = 'completed';
      return value;
    };
    const result = await collect(input);
    assert.equal(result.work[0].activity.value, null);
    assert.equal(result.work[0].native, null);
    assert.equal(result.work[0].waiting.value,
      conflict === 'interval' ? null : 'no-admission-observed');
    if (conflict === 'interval')
      assert.ok(result.errors.includes('OBSERVATION_CHANGED'));
  });
}
