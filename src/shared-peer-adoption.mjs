import { retiredPeerReplaceable } from './retirement-rebind.mjs';
import { requireNoRetirement } from './retirement-admission.mjs';
import { compareProviderViews } from './provider-binding.mjs';
import { withManagedAdmission } from './managed-credential-admission.mjs';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { boundedHostFile, coreRoot, hostFile } from './host-adoption.mjs';
import { rootOwnedPath } from './host-paths.mjs';
import { inspectSharedHost, sharedHostRegistrations } from './shared-host-inspect.mjs';
import { GitHubReader, repoPath } from './github-read.mjs';
import { callerRecipe } from './caller-recipes.mjs';
import { gitBlob, isId, isSha, digest, requireThat } from './identity.mjs';
import { syncRecoveryDirectory } from './recovery-lock.mjs';
import { verifyInstalledSource } from './source-package.mjs';

const issueWorkflow = '.github/workflows/nibfin-issue.yml';
const actionWorkflow = '.github/workflows/nibfin-wake.yml';
const reusableWorkflow = '.github/workflows/issue.yml';

export async function observePeer(reader, name, id, memberId, source, actionCommit) {
  const root = repoPath(name);
  requireThat(isId(id) && isId(memberId) && isSha(source.commit) && isSha(actionCommit),
    'INVALID_PEER_INSTALLATION_IDENTITY');
  const [repo, actor] = await Promise.all([reader.get(root), reader.get('/user')]);
  requireThat(repo.id === id && repo.full_name === name && repo.private === false &&
    repo.archived === false && repo.disabled === false &&
    typeof repo.default_branch === 'string' && repo.default_branch &&
    actor.type === 'User' && actor.id === memberId &&
    /^[A-Za-z0-9-]+$/.test(actor.login ?? ''),
  'PEER_INSTALLATION_IDENTITY_CHANGED');
  const branchPath = `${root}/branches/${encodeURIComponent(repo.default_branch)}`;
  const [branch, permission] = await Promise.all([
    reader.get(branchPath),
    reader.get(`${root}/collaborators/${actor.login}/permission`),
  ]);
  const head = branch.commit?.sha;
  requireThat(branch.name === repo.default_branch && isSha(head),
    'PEER_DEFAULT_BRANCH_UNAVAILABLE');
  requireThat(permission?.user?.id === memberId && permission.permission === 'admin',
    'PEER_INSTALLATION_ADMIN_REQUIRED');
  const issue = ['issue', 'issue-managed'].map(kind => callerRecipe(kind, source.commit));
  const action = callerRecipe('action-dispatch', source.commit, {
    actionCommit, memberId,
  });
  const [eventBinding, actionBinding] = await Promise.all([
    observeAdoptionWorkflow(reader, root, issueWorkflow, head, issue),
    observeAdoptionWorkflow(reader, root, actionWorkflow, head, action),
  ]);
  requireThat((await reader.get(branchPath)).commit?.sha === head,
    'PEER_DEFAULT_BRANCH_CHANGED');
  return { head, issue: eventBinding, action: actionBinding, repo, actor, branch };
}

export async function observeAdoptionWorkflow(reader, root, path, head, expected) {
  const [actual, file] = await Promise.all([
    reader.get(`${root}/actions/workflows/${path.split('/').at(-1)}`),
    reader.get(`${root}/contents/${path}?ref=${head}`),
  ]);
  requireThat(isId(actual.id) && actual.state === 'active' && actual.path === path &&
    file.type === 'file' && file.path === path && file.encoding === 'base64' &&
    typeof file.content === 'string' &&
    file.sha === gitBlob(Buffer.from(file.content, 'base64')),
  'PEER_WORKFLOW_NOT_VERIFIED');
  const body = Buffer.from(file.content, 'base64').toString('utf8');
  requireThat([expected].flat().some(value =>
    body.replaceAll('\r\n', '\n') === value.replaceAll('\r\n', '\n')),
    'CALLER_NOT_FIXED_RECIPE');
  return { workflowId: actual.id, workflowPath: path, workflowBlob: file.sha };
}

export function peerConfiguration(host, name, id, source, actionCommit, observed, blob) {
  const { runner } = host.sharedRunner;
  const identity = {
    repository: name, repositoryId: id, memberId: host.memberId,
    runnerId: runner.runnerId, runnerName: runner.runnerName,
    sourceCommit: observed.head,
  };
  const reusable = {
    repository: source.repository, path: reusableWorkflow, commit: source.commit,
    ref: `${source.repository}/${reusableWorkflow}@${source.commit}`, blob,
  };
  const { schemaVersion, kind, uid, stateRoot, memberId, installation } = host;
  return {
    schemaVersion, kind, uid, stateRoot, memberId, installation,
    ...(host.providerBinding === undefined ? {} :
      { providerBinding: structuredClone(host.providerBinding) }),
    runnerId: runner.runnerId,
    repository: {
      approval: { kind: 'repository-admission-v1', repository: name,
        repositoryId: id, memberId, source },
      runner: { ...identity, ...observed.action, actionCommit,
        actionCoreCommit: source.commit },
      eventRunner: { ...identity, ...observed.issue, reusable },
      eventCaller: { eventName: 'issues', reusable: { commit: source.commit,
        ref: reusable.ref } },
      isolation: host.repository.isolation,
      reviewers: [],
    },
  };
}

async function replace(path, value) {
  const temp = join(dirname(path), `.nibfin-peer-${randomUUID()}`);
  const json = JSON.stringify(value) + '\n';
  requireThat(Buffer.byteLength(json) <= 262144, 'HOST_FILE_TOO_LARGE');
  const file = await open(temp, 'wx', 0o644);
  try {
    try {
      await file.writeFile(json);
      await file.sync();
    } finally { await file.close(); }
    await rename(temp, path);
    await syncRecoveryDirectory(dirname(path));
  } finally {
    await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

export async function adoptSharedPeer(name, id, actionCommit) {
  requireThat(process.platform === 'linux' && process.getuid() === 0 &&
    coreRoot === '/opt/nibfin/core', 'PEER_INSTALLATION_REQUIRES_HOST_ADMIN');
  return withManagedAdmission(() => withSharedAdoptionLock(directory =>
    adoptPeerLocked(name, id, actionCommit, directory)));
}

function recipeBlobs(kind, commit) {
  const text = callerRecipe(kind, commit).replaceAll('\r\n', '\n');
  return [gitBlob(text), gitBlob(text.replaceAll('\n', '\r\n'))];
}

export function managedIssueBinding(event, observed, commit) {
  const managed = recipeBlobs('issue-managed', commit);
  requireThat(event && isSha(observed.head) && event.workflowId === observed.issue.workflowId &&
    event.workflowPath === issueWorkflow && observed.issue.workflowPath === issueWorkflow &&
    event.reusable?.commit === commit &&
    managed.includes(observed.issue.workflowBlob) &&
    [...managed, ...recipeBlobs('issue', commit)].includes(event.workflowBlob),
  'MANAGED_ISSUE_TRANSITION_CONFLICT');
  return event.workflowBlob === observed.issue.workflowBlob ? event :
    { ...event, ...observed.issue, sourceCommit: observed.head };
}

export async function refreshManagedIssueCaller(name, id) {
  requireThat(process.platform === 'linux' && process.getuid() === 0 &&
    coreRoot === '/opt/nibfin/core', 'PEER_INSTALLATION_REQUIRES_HOST_ADMIN');
  return withManagedAdmission(() => withSharedAdoptionLock(async () => {
    await requireNoRetirement();
    const read = async path => {
      await rootOwnedPath(path);
      const bytes = await boundedHostFile(path, 262144);
      return { path, bytes, value: JSON.parse(bytes) };
    };
    const primary = await read(hostFile);
    const host = primary.value;
    const pool = sharedHostRegistrations(host);
    requireThat(isId(id) && host.sharedRunner.repositories.includes(id),
      'SHARED_REPOSITORY_NOT_ADOPTED');
    const peers = host.wakePeerFiles ?? [];
    requireThat(Array.isArray(peers) && peers.length <= 10 &&
      peers.every(path => /^\/etc\/nibfin\/host\.[A-Za-z0-9_-]+\.json$/.test(path)),
    'INVALID_WAKE_PEER_PATH');
    const matches = (id === pool.repositoryId ? [primary] : await Promise.all(peers.map(read)))
      .filter(entry => entry.value.repository?.approval?.repositoryId === id);
    requireThat(matches.length === 1, 'SHARED_REPOSITORY_NOT_ADOPTED');
    const target = matches[0];
    const adopted = target.value.repository;
    compareProviderViews(host, target.value);
    requireThat(adopted.approval.repository === name &&
      adopted.approval.memberId === host.memberId &&
      digest(target.value.installation) === digest(host.installation),
    'MANAGED_ISSUE_TRANSITION_CONFLICT');
    const source = await verifyInstalledSource(coreRoot, host.installation.pin);
    const actionCommit = adopted.runner.actionCommit;
    const reader = await adoptionReader(host);
    await verifyAdoptionAction(reader, actionCommit, host.installation.pin);
    const observed = await observePeer(reader, name, id, host.memberId, source, actionCommit);
    requireThat(adopted.runner.workflowId === observed.action.workflowId &&
      adopted.runner.workflowBlob === observed.action.workflowBlob,
    'MANAGED_ISSUE_TRANSITION_CONFLICT');
    const event = managedIssueBinding(adopted.eventRunner, observed, source.commit);
    if (event === adopted.eventRunner)
      return { status: 'unchanged', repositoryId: id, runners: pool.runners };
    for (const entry of new Set([primary, target]))
      requireThat(await boundedHostFile(entry.path, 262144) === entry.bytes,
        'HOST_ADOPTION_CHANGED');
    adopted.eventRunner = event;
    await replace(target.path, target.value);
    const readback = await read(target.path);
    requireThat(digest(readback.value) === digest(target.value), 'PEER_ADOPTION_UNVERIFIED');
    return { status: 'adopted', repositoryId: id, runners: pool.runners };
  }));
}

export const retirementLockMarker = '{"kind":"managed-retirement-v1"}\n';

export async function withSharedAdoptionLock(action, { retirement = false } = {}) {
  const directory = dirname(hostFile);
  await rootOwnedPath(directory);
  const lock = join(directory, 'rollout.lock');
  const guard = await open(lock, 'wx', 0o600).catch(error => {
    if (error.code === 'EEXIST') {
      requireThat(false, 'HOST_ROLLOUT_OR_ADOPTION_UNRESOLVED');
    }
    throw error;
  });
  try {
    if (retirement) {
      await guard.writeFile(retirementLockMarker);
      await guard.sync();
      await syncRecoveryDirectory(directory);
    }
    return await action(directory);
  } finally {
    await guard.close();
    await unlink(lock);
    await syncRecoveryDirectory(directory);
  }
}

async function adoptPeerLocked(name, id, actionCommit, directory) {
  await requireNoRetirement();
  requireThat(isSha(actionCommit), 'INVALID_PEER_INSTALLATION_IDENTITY');
  await rootOwnedPath(hostFile);
  const current = await boundedHostFile(hostFile, 262144);
  const host = JSON.parse(current);
  const pool = sharedHostRegistrations(host);
  requireThat(isId(id) && id !== pool.repositoryId, 'PEER_CANNOT_REPLACE_EXECUTION_HOST');
  const source = await verifyInstalledSource(coreRoot, host.installation.pin);
  const reader = await adoptionReader(host);
  await verifyAdoptionAction(reader, actionCommit, host.installation.pin);
  const observed = await observePeer(
    reader, name, id, host.memberId, source, actionCommit);
  return publishPeer(host, pool, current, name, id, source, actionCommit,
    observed, directory);
}

async function adoptionReader(host) {
  // Only a local administrator may read the existing Controller credential.
  const credentials = await lstat(dirname(host.tokenFile));
  const stat = await lstat(host.tokenFile);
  requireThat(credentials.isDirectory() && credentials.uid === host.uid &&
    (credentials.mode & 0o077) === 0 && stat.isFile() && stat.uid === host.uid &&
    stat.nlink === 1 && (stat.mode & 0o077) === 0, 'CONTROLLER_CREDENTIAL_NOT_PRIVATE');
  const token = (await boundedHostFile(host.tokenFile, 16384)).trim();
  return new GitHubReader(token);
}

export async function verifyAdoptionAction(reader, actionCommit, pin) {
  const producer = await reader.get(
    `/repos/taco3064/nibfin-act/contents/core-source.json?ref=${actionCommit}`);
  requireThat(producer.type === 'file' && producer.encoding === 'base64' &&
    typeof producer.content === 'string' &&
    digest(JSON.parse(Buffer.from(producer.content, 'base64'))) ===
      digest(pin), 'PEER_ACTION_SOURCE_MISMATCH');
}

async function publishPeer(host, pool, current, name, id, source, actionCommit,
  observed, directory) {
  const path = join(directory, `host.peer-${id}.json`);
  const peers = host.wakePeerFiles ?? [];
  requireThat(Array.isArray(peers), 'INVALID_WAKE_PEER_PATH');
  const reusable = await boundedHostFile(join(coreRoot, reusableWorkflow), 65536);
  const peer = peerConfiguration(host, name, id, source, actionCommit, observed,
    gitBlob(reusable));
  // Write the complete peer first. Routing remains disabled until the
  // primary file publishes its ID. On interruption only an exact peer resumes.
  let existing;
  try {
    await rootOwnedPath(path);
    existing = JSON.parse(await boundedHostFile(path, 262144));
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const adopted = host.sharedRunner.repositories.includes(id);
  requireThat(adopted === peers.includes(path), 'PEER_HOST_FILE_CONFLICT');
  if (adopted) {
    compareProviderViews(host, existing ?? {});
    requireThat(existing?.repository?.approval?.repository === name &&
      existing.repository.approval.repositoryId === id &&
      existing.memberId === host.memberId &&
      digest(existing.installation) === digest(peer.installation) &&
      existing.repository.runner.actionCommit === actionCommit &&
      existing.repository.runner.workflowId === observed.action.workflowId &&
      existing.repository.eventRunner.workflowId === observed.issue.workflowId,
    'PEER_HOST_FILE_CONFLICT');
    return { status: 'unchanged', repositoryId: id, runners: pool.runners };
  }
  // Older deployments may carry a second copy of the pool policy. Introducing
  // a peer into only one copy would invalidate both views.
  await inspectSharedHost();
  for (const path of peers) {
    await rootOwnedPath(path);
    const prior = JSON.parse(await boundedHostFile(path, 262144));
    requireThat(prior.runnerUid !== host.sharedRunner.additionalRunner.uid,
      'PEER_REQUIRES_SINGLE_SHARED_HOST_CONFIGURATION');
  }
  requireThat(peers.length < 10, 'SHARED_PEER_LIMIT_REACHED');
  const retiredPeer = existing && await retiredPeerReplaceable(path, existing);
  requireThat(!existing || retiredPeer || digest(existing) === digest(peer),
    'PEER_HOST_FILE_CONFLICT');
  requireThat(await boundedHostFile(hostFile, 262144) === current,
    'HOST_ADOPTION_CHANGED');
  if (!existing || retiredPeer) await replace(path, peer);
  host.wakePeerFiles = [...peers, path];
  host.sharedRunner.repositories = [...host.sharedRunner.repositories, id];
  await replace(hostFile, host);
  const receipt = await inspectSharedHost();
  requireThat(receipt.adoptedRepositoryIds.includes(id), 'PEER_ADOPTION_UNVERIFIED');
  return { status: 'adopted', repositoryId: id, runners: pool.runners };
}
