import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { boundedHostFile, coreRoot, hostFile } from './host-adoption.mjs';
import { rootOwnedPath } from './host-paths.mjs';
import { inspectSharedHost, sharedHostRegistrations } from './shared-host-inspect.mjs';
import { GitHubReader, repoPath } from './github-read.mjs';
import { callerRecipe } from './caller-recipes.mjs';
import { checkProtection } from './github-protection.mjs';
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
  const [branch, permission, protection] = await Promise.all([
    reader.get(branchPath),
    reader.get(`${root}/collaborators/${actor.login}/permission`),
    reader.get(`${branchPath}/protection`),
  ]);
  const head = branch.commit?.sha;
  requireThat(branch.protected === true && isSha(head), 'PEER_BRANCH_UNPROTECTED');
  requireThat(permission?.user?.id === memberId && permission.permission === 'admin',
    'PEER_INSTALLATION_ADMIN_REQUIRED');
  checkProtection(protection);
  const workflow = async (path, recipe) => {
    const [actual, file] = await Promise.all([
      reader.get(`${root}/actions/workflows/${path.split('/').at(-1)}`),
      reader.get(`${root}/contents/${path}?ref=${head}`),
    ]);
    requireThat(isId(actual.id) && actual.state === 'active' && actual.path === path &&
      file.type === 'file' && file.path === path && file.encoding === 'base64' &&
      typeof file.content === 'string' &&
      file.sha === gitBlob(Buffer.from(file.content, 'base64')),
    'PEER_WORKFLOW_NOT_VERIFIED');
    const text = Buffer.from(file.content, 'base64').toString('utf8');
    requireThat(text.replaceAll('\r\n', '\n') ===
      callerRecipe(recipe.kind, recipe.coreCommit, recipe), 'CALLER_NOT_FIXED_RECIPE');
    return { workflowId: actual.id, workflowPath: path, workflowBlob: file.sha };
  };
  const [issue, action] = await Promise.all([
    workflow(issueWorkflow, { kind: 'issue', coreCommit: source.commit }),
    workflow(actionWorkflow, { kind: 'action-dispatch', coreCommit: source.commit,
      actionCommit, memberId }),
  ]);
  requireThat((await reader.get(branchPath)).commit?.sha === head,
    'PEER_DEFAULT_BRANCH_CHANGED');
  return { head, issue, action };
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
    return await adoptPeerLocked(name, id, actionCommit, directory);
  } finally {
    await guard.close();
    await unlink(lock);
    await syncRecoveryDirectory(directory);
  }
}

async function adoptPeerLocked(name, id, actionCommit, directory) {
  requireThat(isSha(actionCommit), 'INVALID_PEER_INSTALLATION_IDENTITY');
  await rootOwnedPath(hostFile);
  const current = await boundedHostFile(hostFile, 262144);
  const host = JSON.parse(current);
  const pool = sharedHostRegistrations(host);
  requireThat(isId(id) && id !== pool.repositoryId, 'PEER_CANNOT_REPLACE_EXECUTION_HOST');
  const source = await verifyInstalledSource(coreRoot, host.installation.pin);
  // Only a local administrator may read this existing Controller credential.
  // It never crosses into CLI output, subprocess arguments or an Agent.
  const token = (await boundedHostFile(host.tokenFile, 16384)).trim();
  const reader = new GitHubReader(token);
  const producer = await reader.get(
    `/repos/taco3064/nibfin-act/contents/core-source.json?ref=${actionCommit}`);
  requireThat(producer.type === 'file' && producer.encoding === 'base64' &&
    typeof producer.content === 'string' &&
    digest(JSON.parse(Buffer.from(producer.content, 'base64'))) ===
      digest(host.installation.pin), 'PEER_ACTION_SOURCE_MISMATCH');
  const observed = await observePeer(
    reader, name, id, host.memberId, source, actionCommit);
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
  requireThat(!existing || digest(existing) === digest(peer),
    'PEER_HOST_FILE_CONFLICT');
  requireThat(await boundedHostFile(hostFile, 262144) === current,
    'HOST_ADOPTION_CHANGED');
  if (!existing) await replace(path, peer);
  host.wakePeerFiles = [...peers, path];
  host.sharedRunner.repositories = [...host.sharedRunner.repositories, id];
  await replace(hostFile, host);
  const receipt = await inspectSharedHost();
  requireThat(receipt.adoptedRepositoryIds.includes(id), 'PEER_ADOPTION_UNVERIFIED');
  return { status: 'adopted', repositoryId: id, runners: pool.runners };
}
