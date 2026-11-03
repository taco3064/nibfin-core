import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalProviderFixture } from './github-approval-fixture.mjs';
import { runnerProviderFixture } from './runner-binding-fixture.mjs';
import { stageFixture } from './stage-fixture.mjs';
import { now } from './approval-fixture.mjs';
import { nativeObserver } from '../src/native-observer.mjs';

export async function nativeFixture(t, record) {
  const authority = approvalProviderFixture(record), runner = runnerProviderFixture(), context = stageFixture();
  const root = await mkdtemp(join(tmpdir(), 'nibfin-observer-')); t.after(() => rm(root, { recursive: true, force: true }));
  const member = { id: 1, login: 'writer', type: 'User' };
  runner.expected.member = member; runner.expected.memberId = 1;
  runner.job.labels = ['self-hosted', 'nibfin-user-1']; runner.runner.labels = runner.job.labels.map(name => ({ name }));
  const issue = { ...context.issue, body: authority.record.scope.body, assignees: [member] };
  const data = { ...authority.data, ...runner.data, '/collaborators/writer/permission': { user: member, permission: 'write' },
    '/git/ref/heads/main': { ref: 'refs/heads/main', object: { type: 'commit', sha: '1'.repeat(40) } },
    '/issues/2/dependencies/blocked_by': [] };
  const reader = { repository: async () => structuredClone(authority.repo), issue: async () => structuredClone(issue),
    get: async path => { const key = path.slice('/repos/example/core'.length); assert.ok(Object.hasOwn(data, key), key); return structuredClone(data[key]); } };
  reader.list = path => reader.get(path); reader.blockedBy = () => reader.list('/repos/example/core/issues/2/dependencies/blocked_by');
  const execution = { ...context.execution, runId: runner.expected.runId, attempt: runner.expected.attempt, jobId: runner.expected.jobId };
  const config = { approval: authority.pin, runner: runner.expected, stateRoot: root };
  const adapters = { reader, config, execution, clock: () => now,
    inspectSource: async () => authority.record.source,
    inspectCaller: async actual => ({ ...actual, identityHash: 'a'.repeat(64), expiresAt: now + 60000 }),
    inspectIsolation: async () => ({ ...context.isolation, executionId: execution.id }),
  };
  const observe = nativeObserver(adapters);
  return { observe, data, issue, runner, adapters, root, context, authority };
}
