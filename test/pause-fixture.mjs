import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { GitHubReader } from '../src/github-read.mjs';
import { OperationJournal } from '../src/operation-journal.mjs';
import { reconcilePause } from '../src/pause-repair.mjs';

export const owner = { id: 1, login: 'owner', type: 'User' };
export const member = { id: 2, login: 'member', type: 'User' };
export const other = { id: 3, login: 'other', type: 'User' };
export const bot = { id: 4, login: 'repair[bot]', type: 'Bot' };
export const identity = { id: 'I_pause', number: 7,
  repositoryId: 10, repository: 'example/core' };

export function additionEvent(issue, native) {
  return { action: native.event, label: { name: 'pause' }, sender: native.actor,
    issue: { ...structuredClone(issue), updated_at: native.created_at } };
}

export function pauseFixture() {
  const repository = { id: 10, full_name: 'example/core', private: false,
    owner, default_branch: 'main' };
  const issue = { node_id: identity.id, number: identity.number, state: 'open',
    title: 'Keep title', body: 'Keep body', assignees: [member],
    url: 'https://api.github.com/repos/example/core/issues/7',
    labels: [{ name: 'scope' }, { name: 'unrelated' }] };
  const events = [], permissions = new Map([
    [member.login, { user: member, permission: 'write' }],
    [other.login, { user: other, permission: 'admin' }],
    [owner.login, { user: owner, permission: 'admin' }],
  ]);
  const state = { repository, issue, events, permissions,
    actor: bot, authority: true, writes: 0, reads: 0, failure: null };
  const add = (actor = owner, desired = true) => {
    const id = events.length + 1;
    const event = { id, event: desired ? 'labeled' : 'unlabeled',
      created_at: new Date(Date.UTC(2026, 10, 12, 0, 0, id)).toISOString(),
      actor: structuredClone(actor),
      label: { name: 'pause' },
      url: `https://api.github.com/repos/example/core/issues/events/${id}` };
    events.push(event);
    issue.labels = issue.labels.filter(label => label.name !== 'pause');
    if (desired) issue.labels.push({ name: 'pause' });
    return event;
  };
  const fetcher = async (url, options) => {
    const path = new URL(url).pathname;
    if (options.method !== 'GET') {
      state.writes++;
      assert.equal(options.redirect, 'error');
      assert.ok(path.endsWith('/labels') || path.endsWith('/labels/pause'));
      if (options.method === 'POST') {
        assert.deepEqual(JSON.parse(options.body), { labels: ['pause'] });
        add(state.actor, true);
      } else {
        assert.equal(options.method, 'DELETE');
        assert.equal(options.body, undefined);
        add(state.actor, false);
      }
      if (state.failure === 'lost') throw new Error('Lost response');
      if (state.failure === 'body') issue.body = 'Contradictory readback';
      if (state.failure === 'label') issue.labels = [{ name: 'unrelated' }];
      return { ok: state.failure !== 'failed', json: async () => issue.labels };
    }
    state.reads++;
    let value;
    if (path.endsWith('/issues/7/events')) {
      if (state.failure === 'history') throw new Error('Unavailable history');
      const page = Number(new URL(url).searchParams.get('page'));
      value = events.slice((page - 1) * 100, page * 100);
    } else if (path.endsWith('/issues/7')) value = issue;
    else if (path === '/repos/example/core') value = repository;
    else if (path.endsWith('/permission')) {
      const login = decodeURIComponent(path.split('/').at(-2));
      value = permissions.get(login);
      if (!value) return { ok: false, status: 404 };
    } else if (path === '/user') value = state.actor;
    else assert.fail(path);
    return { ok: true, json: async () => structuredClone(value) };
  };
  const reader = new GitHubReader('fixture-only', fetcher);
  return { ...state, state, reader, fetcher, add };
}

export async function repairFixture(t) {
  const f = pauseFixture();
  const root = await mkdtemp(join(tmpdir(), 'nibfin-pause-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const journal = new OperationJournal(root, identity);
  const authorize = async () => {
    assert.equal(f.state.authority, true, 'Revoked authority');
    return { actorId: f.state.actor.id, approvalHash: 'a'.repeat(64) };
  };
  const repair = event => reconcilePause({ reader: f.reader, issue: identity,
    token: 'fixture-only', journal, authorize, fetcher: f.fetcher, event });
  return { ...f, journal, root, repair };
}
