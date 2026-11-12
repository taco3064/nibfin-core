import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { OperationJournal } from '../src/operation-journal.mjs';
import { reconcilePause } from '../src/pause-controller.mjs';

export const people = {
  owner: { id: 1, login: 'owner', type: 'User' },
  assignee: { id: 2, login: 'assignee', type: 'User' },
  controller: { id: 3, login: 'controller', type: 'User' },
  stranger: { id: 4, login: 'stranger', type: 'User' },
};
export const pauseIdentity = {
  repository: 'example/core',
  repositoryId: 10,
  id: 'I_target',
  number: 2,
};

export async function pauseFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'pause-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = {
    id: 10,
    full_name: 'example/core',
    private: false,
    owner: people.owner,
  };
  const issue = {
    node_id: 'I_target',
    number: 2,
    state: 'open',
    body: 'Keep this body',
    url: 'https://api.github.com/repos/example/core/issues/2',
    labels: [{ name: 'scope' }, { name: 'unrelated' }],
    assignees: [people.assignee],
    updated_at: '2026-11-12T00:00:00Z',
  };
  const events = [],
    permissions = {
      assignee: 'triage',
      controller: 'write',
      stranger: 'write',
    };
  let writes = 0,
    inspections = 0,
    fault;
  const emit = (actor, action) => {
    issue.labels = issue.labels.filter((label) => label.name !== 'pause');
    if (action === 'labeled') issue.labels.push({ name: 'pause' });
    issue.updated_at = new Date(
      Date.UTC(2026, 10, 12, 0, 0, events.length + 1),
    ).toISOString();
    const native = {
      id: events.length + 1,
      event: action,
      actor,
      label: { name: 'pause' },
      created_at: issue.updated_at,
    };
    events.push(native);
    return {
      action,
      sender: actor,
      label: { name: 'pause' },
      issue: structuredClone(issue),
    };
  };
  const reader = {
    repository: async () => structuredClone(repository),
    issue: async () => structuredClone(issue),
    list: async (path) => {
      assert.equal(path, '/repos/example/core/issues/2/events');
      if (fault === 'history') throw new Error('Unavailable history');
      return structuredClone(events);
    },
    get: async (path) => {
      if (path === '/user') return structuredClone(people.controller);
      const login = path.match(/\/collaborators\/([^/]+)\/permission$/)?.[1];
      const user = Object.values(people).find((user) => user.login === login);
      assert.ok(user, path);
      return { user: structuredClone(user), permission: permissions[login] };
    },
  };
  const journal = new OperationJournal(root, pauseIdentity);
  const fetcher = async (url, options) => {
    assert.equal((await journal.pauseEvidence()).pending, true);
    writes++;
    assert.equal(options.redirect, 'error');
    assert.ok(url.endsWith(options.method === 'POST' ? '/labels' : '/labels/pause'));
    if (options.method === 'POST')
      assert.deepEqual(JSON.parse(options.body), { labels: ['pause'] });
    if (fault === 'lost') throw new Error('Lost response');
    if (fault !== 'dropped')
      emit(people.controller, options.method === 'POST' ? 'labeled' : 'unlabeled');
    return Response.json([]);
  };
  const inspect = async () => {
    inspections++;
    if (fault === 'revoked') throw new Error('Revoked authority');
  };
  const reconcile = (event) =>
    reconcilePause({
      reader,
      issue: pauseIdentity,
      event,
      journal,
      inspect,
      token: 'fixture-token',
      actorId: people.controller.id,
      fetcher,
    });
  return {
    root,
    fetcher,
    repository,
    issue,
    events,
    reader,
    journal,
    emit,
    reconcile,
    permissions,
    fault: (value) => {
      fault = value;
    },
    writes: () => writes,
    inspections: () => inspections,
  };
}
