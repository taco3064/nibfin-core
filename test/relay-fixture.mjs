import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import { gitBlob, sha256 } from '../src/identity.mjs';
import { callerRecipe } from '../src/caller-recipes.mjs';
import { projectManagedWake, serializeManagedWake } from '../src/managed-wake.mjs';
import { boundedHostFile } from '../src/host-adoption.mjs';
import { RelayReader } from '../src/relay-http.mjs';
import { RelayJournal, writeRelayState } from '../src/relay-state.mjs';
import { NotificationRelay } from '../src/notification-relay.mjs';
import { sharedWorkflowPath } from '../src/shared-runner.mjs';

export const coreCommit = 'a'.repeat(40), head = 'b'.repeat(40);
export const origin = { repository: 'owner/project', repositoryId: 1, ref: 'main',
  workflow: { id: 20, path: '.github/workflows/nibfin-issue.yml', commit: head,
    blob: gitBlob(callerRecipe('issue-managed', coreCommit)) } };
export const actor = { id: 4, login: 'owner', type: 'User' };
export const original = { id: 30, run_attempt: 1, event: 'issues', status: 'completed',
  conclusion: 'success', workflow_id: 20, path: origin.workflow.path,
  head_sha: head, head_branch: 'main',
  repository: { id: 1, full_name: origin.repository },
  head_repository: { id: 1 }, actor, triggering_actor: actor,
  referenced_workflows: [{ path:
    `taco3064/nibfin-core/.github/workflows/issue.yml@${coreCommit}`, sha: coreCommit }],
  run_started_at: '2026-11-16T00:00:00Z', updated_at: '2026-11-16T00:01:00Z' };
export function wakeEvent(action = 'opened') {
  return { action, repository: { id: 1, full_name: origin.repository },
    issue: { id: 2, node_id: 'I_example', number: 3, state: 'open',
      updated_at: '2026-11-16T00:00:00Z', assignees: [actor], labels: [] },
    sender: actor, ...(['labeled', 'unlabeled'].includes(action)
      ? { label: { name: 'pause' } } : {}) };
}
export function payload(event = wakeEvent()) {
  return serializeManagedWake(projectManagedWake(event, {
    repository: origin.repository, eventName: 'issues', runId: 30, attempt: 1,
  }));
}

export function zip(bytes, { method = 8, descriptor = false, name = 'issue-wake.json' }
  = {}) {
  const data = Buffer.from(bytes), filename = Buffer.from(name);
  const compressed = method === 8 ? deflateRawSync(data) : data;
  const local = Buffer.alloc(30), central = Buffer.alloc(46), end = Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50);
  local.writeUInt16LE(20, 4); local.writeUInt16LE(descriptor ? 8 : 0, 6);
  local.writeUInt16LE(method, 8); local.writeUInt16LE(filename.length, 26);
  if (!descriptor) {
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(data.length, 22);
  }
  central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 6);
  central.writeUInt16LE(descriptor ? 8 : 0, 8); central.writeUInt16LE(method, 10);
  central.writeUInt32LE(crc32(data), 16);
  central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(filename.length, 28);
  const trailer = Buffer.alloc(descriptor ? 16 : 0);
  if (descriptor) {
    trailer.writeUInt32LE(0x08074b50); trailer.writeUInt32LE(crc32(data), 4);
    trailer.writeUInt32LE(compressed.length, 8); trailer.writeUInt32LE(data.length, 12);
  }
  const before = Buffer.concat([local, filename, compressed, trailer]);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + filename.length, 12);
  end.writeUInt32LE(before.length, 16);
  return Buffer.concat([before, central, filename, end]);
}

export async function relayFixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'notification-relay-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const credential = join(root, 'token');
  await writeFile(credential, 'fake-controller-token', { mode: 0o600 });
  const token = await boundedHostFile(credential, 1024, true);
  const journal = new RelayJournal(root);
  await writeRelayState(root, 'control.json', { schemaVersion: 1, paused: false });
  const shared = await readFile(new URL('../.github/workflows/shared-runner.yml',
    import.meta.url), 'utf8');
  const source = callerRecipe(options.callerKind ?? 'issue-managed', coreCommit);
  const runner = { repository: 'owner/execution', repositoryId: 5,
    workflowId: 50, workflowPath: sharedWorkflowPath, sourceCommit: head,
    workflowBlob: gitBlob(shared), memberId: 4,
    sharedAdmission: { kind: 'repository-admission-v1', repository: 'owner/execution',
      repositoryId: 5, memberId: 4, ownerId: 4 } };
  const fixture = { root, journal, posts: 0, reads: 0, storage: [], ids: [60],
    now: Date.parse('2026-11-16T00:02:00Z'), options };
  const nativeRun = id => ({ id, run_attempt: 1, event: 'workflow_dispatch',
    actor, triggering_actor: actor, workflow_id: 50, path: sharedWorkflowPath,
    head_sha: head, head_branch: 'main', head_repository: { id: 5 },
    repository: { id: 5, full_name: 'owner/execution' },
    display_title: 'Nibfin 1 #3 wake', created_at: '2026-11-16T00:02:01Z',
    ...options.nativeRun });
  const archive = options.archive ?? zip(options.payload ?? payload(options.event));
  const artifact = { id: 40, name: 'nibfin-issue-wake-v1-1', expired: false,
    size_in_bytes: archive.length, digest: `sha256:${sha256(archive)}`,
    workflow_run: { id: 30, repository_id: 1, head_repository_id: 1,
      head_branch: 'main', head_sha: head },
    created_at: '2026-11-16T00:00:20Z', updated_at: '2026-11-16T00:00:30Z',
    ...options.artifact };
  const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value),
    { status, headers });
  fixture.fetcher = async (url, init = {}) => {
    const parsed = new URL(url), path = parsed.pathname;
    if (parsed.hostname.endsWith('.blob.core.windows.net')) {
      fixture.storage.push(init.headers);
      if (options.storage) return options.storage(url, init);
      return new Response(archive);
    }
    if (init.headers?.Authorization !== `Bearer ${token}`)
      throw new Error('Missing private Controller credential');
    if (init.method === 'POST') {
      fixture.posts++;
      const intent = await journal.read({ repositoryId: 1, runId: 30, attempt: 1 });
      if (intent?.status !== 'pending') throw new Error('Intent missing before POST');
      fixture.sent = JSON.parse(init.body);
      if (options.post) return options.post(fixture);
      return json({ workflow_run_id: 60,
        html_url: 'https://github.com/owner/execution/actions/runs/60' });
    }
    fixture.reads++;
    if (options.intercept) {
      const value = await options.intercept(parsed, init, fixture);
      if (value !== undefined) return value;
    }
    if (path === '/user') return json(options.actor ?? actor);
    const destination = path.startsWith('/repos/owner/execution');
    const repoId = destination ? 5 : 1, repo = destination ? 'owner/execution'
      : origin.repository;
    const rootPath = `/repos/${repo}`;
    if (path === rootPath) return json({ id: repoId, full_name: repo,
      private: false, archived: false, disabled: false, default_branch: 'main',
      owner: { id: 4 }, ...options.repository });
    if (path === rootPath + '/branches/main')
      return json({ name: 'main', protected: false, commit: { sha: head } });
    if (path === rootPath + '/actions/workflows/' + (destination ? 50 : 20))
      return json({ id: destination ? 50 : 20, state: 'active',
        path: destination ? sharedWorkflowPath : origin.workflow.path });
    if (path.startsWith(rootPath + '/contents/')) {
      const content = destination ? shared : source;
      return json({ type: 'file', path: destination ? sharedWorkflowPath
        : origin.workflow.path, sha: gitBlob(content), encoding: 'base64',
        size: Buffer.byteLength(content),
        content: Buffer.from(content).toString('base64') });
    }
    if (path.endsWith('/actions/runs/30/attempts/1'))
      return json({ ...original, ...options.original });
    if (path.endsWith('/actions/runs/30')) return json({ ...original,
      run_attempt: options.latestAttempt ?? 1, ...options.original });
    if (path.endsWith('/actions/runs/30/artifacts'))
      return json({ artifacts: options.missing ? [] : [artifact],
        total_count: options.incomplete ? 2 : options.missing ? 0 : 1 });
    if (path.endsWith('/actions/artifacts/40')) return json(artifact);
    if (path.endsWith('/actions/artifacts/40/zip')) return new Response(null,
      { status: 302, headers: { location: options.location ??
        'https://example.blob.core.windows.net/wake?secret=storage' } });
    if (path.endsWith('/collaborators/owner/permission'))
      return json({ user: actor, permission: options.permission ?? 'write' });
    if (path.endsWith('/issues/3')) return json({ ...wakeEvent().issue,
      labels: [{ name: 'scope' }], url: `https://api.github.com${rootPath}/issues/3`,
      ...options.issue });
    if (path.endsWith('/dependencies/blocked_by'))
      return json(options.dependencies ?? []);
    if (path.endsWith('/actions/workflows/20/runs'))
      return json({ workflow_runs: [{ ...original, run_attempt: 2 }], total_count: 1 },
        200, { etag: '"example"' });
    if (path.endsWith('/actions/workflows/50/runs'))
      return json({ workflow_runs: fixture.ids.map(nativeRun),
        total_count: fixture.ids.length });
    if (/\/actions\/runs\/\d+$/.test(path) && destination)
      return json(nativeRun(Number(path.split('/').at(-1))));
    throw new Error(`Unexpected API fixture: ${path}`);
  };
  fixture.configuration = { origins: [origin], coreCommit, runner, memberId: 4 };
  fixture.relay = () => new NotificationRelay({
    reader: new RelayReader(token, fixture.fetcher), token, journal,
    configuration: fixture.configuration, inspect: options.inspect ?? (async () => {}),
    requireAdmission: options.requireAdmission,
    fetcher: fixture.fetcher, now: () => fixture.now,
  });
  fixture.process = () => fixture.relay().process(origin, 30);
  return fixture;
}
