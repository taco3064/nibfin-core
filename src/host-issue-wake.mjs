import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  loadHostAdoption,
  boundedHostFile,
  rootOwnedPath,
  inspectHostAdoption,
} from './host-adoption.mjs';
import { privateHostDirectory } from './host-fence.mjs';
import {
  resolveHostJob,
  readSelectedHost,
  hostWakeExecution,
} from './host-launcher.mjs';
import { actionsCaller } from './actions-identity.mjs';
import { readProtectedApproval } from './github-approval.mjs';
import { dispatchIssueWake } from './issue-wake.mjs';
import { digest, requireThat } from './identity.mjs';
import { relayHostCommand } from './host-relay.mjs';
import { targetContextKey } from './controller-contract.mjs';
import { readForwardedWake } from './shared-wake.mjs';

export function hostWakeAdoption(host, adopted) {
  const event = adopted.eventRunner,
    stage = adopted.runner;
  requireThat(
    event &&
      event.runnerId === host.runnerId &&
      event.runnerName === stage.runnerName &&
      event.memberId === host.memberId &&
      event.repositoryId === stage.repositoryId &&
      event.repository === stage.repository &&
      event.reusable?.repository === 'taco3064/nibfin-core' &&
      event.reusable.path === '.github/workflows/issue.yml' &&
      event.reusable.commit === host.installation.pin.commit &&
      !event.wakeWorkflow &&
      adopted.eventCaller?.eventName === 'issues',
    'EVENT_HOST_NOT_ADOPTED',
  );
  const workflow = (runner) => ({
    id: runner.workflowId,
    path: runner.workflowPath,
    commit: runner.sourceCommit,
    blob: runner.workflowBlob,
    ...(runner.actionCommit ? { actionCommit: runner.actionCommit } : {}),
  });
  const config = (item) => ({
    approvalPin: item.approval,
    workflow: workflow(item.runner),
    actorId: host.memberId,
  });
  return {
    schemaVersion: 1,
    coreCommit: host.installation.pin.commit,
    eventWorkflow: workflow(event),
    issues: Object.values(host.issues ?? {}).map(config),
    ...(host.repository ? { repository: config(host.repository) } : {}),
  };
}

async function readWakePeers(host) {
  const paths = host.wakePeerFiles ?? [];
  requireThat(Array.isArray(paths) && paths.length <= 10 &&
    new Set(paths).size === paths.length, 'INVALID_WAKE_PEERS');
  const peers = [];
  for (const path of paths) {
    requireThat(/^\/etc\/nibfin\/host\.[A-Za-z0-9_-]+\.json$/.test(path),
      'INVALID_WAKE_PEER_PATH');
    await rootOwnedPath(path);
    const peer = JSON.parse(await boundedHostFile(path, 256 * 1024));
    requireThat(
      peer.repository?.approval?.kind === 'repository-admission-v1' &&
        peer.stateRoot === host.stateRoot && peer.uid === host.uid &&
        peer.memberId === host.memberId &&
        digest(peer.installation) === digest(host.installation),
      'WAKE_PEER_NOT_ADOPTED',
    );
    peers.push(hostWakeAdoption(peer, peer.repository).repository);
  }
  const repositories = peers.map(peer => peer.approvalPin.repositoryId);
  requireThat(new Set(repositories).size === repositories.length &&
    !repositories.includes(host.repository?.approval.repositoryId),
  'AMBIGUOUS_WAKE_PEER');
  return peers;
}

// Fixed installed entry only. The hosted resolver supplies a locator, never
// token, storage, adapter, executable or authority configuration.
export async function launchIssueWake(issueNumber, env = process.env, eventBytes) {
  const relayed = await relayHostCommand('dispatch-event', [issueNumber], env);
  if (relayed !== null) return relayed;
  const targetRepositoryId = env[targetContextKey];
  const context = await loadHostAdoption(issueNumber, targetRepositoryId);
  const { host, adopted, reader, token } = context;
  const targetHost = context.targetHost ?? host;
  const shared = targetRepositoryId !== undefined;
  const targetAdoption = shared
    ? targetHost.issues?.[issueNumber] ?? targetHost.repository : adopted;
  const adoption = hostWakeAdoption(targetHost, targetAdoption);
  const eventName = shared ? 'workflow_dispatch' : 'issues';
  const caller = shared ? adopted.caller : adopted.eventCaller;
  const callerAdoption = shared ? adopted
    : { runner: adopted.eventRunner, approval: adopted.approval };
  const { runner, binding } = await resolveHostJob(
    reader, callerAdoption, env, eventName,
  );
  const execution = hostWakeExecution(runner);
  const authenticate = actionsCaller({
    pin: caller,
    requestUrl: env.ACTIONS_ID_TOKEN_REQUEST_URL,
    requestToken: env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
    executionId: execution.id,
  });
  await authenticate(binding);
  const approval = await readProtectedApproval(reader, adopted.approval);
  requireThat(
    approval.record.roles.publisher === runner.memberId &&
      approval.record.operations.includes('wake'),
    'EVENT_PUBLISHER_NOT_APPROVED',
  );
  try {
    const inspect = async () => {
      await inspectHostAdoption(context);
      const fresh = await resolveHostJob(
        reader,
        callerAdoption,
        env,
        eventName,
      );
      await authenticate(fresh.binding);
      const current = await readProtectedApproval(reader, adopted.approval);
      requireThat(
        current.approvalHash === approval.approvalHash &&
          current.record.roles.publisher === runner.memberId &&
          current.record.operations.includes('wake'),
        'EVENT_AUTHORITY_CHANGED',
      );
      await readSelectedHost(reader, runner);
    };
    await inspect();
    requireThat(
      host.runnerUid === undefined || typeof eventBytes === 'string',
      'CONTROLLER_EVENT_TRANSPORT_REQUIRED',
    );
    const bytes = eventBytes ?? await boundedHostFile(env.GITHUB_EVENT_PATH, 1048576);
    const forwarded = shared ? readForwardedWake(bytes, approval.record.issue) : null;
    const event = forwarded?.event ?? JSON.parse(bytes);
    requireThat(
      String(event.issue?.number) === issueNumber &&
        event.issue.node_id === approval.record.issue.id,
      'EVENT_ISSUE_CHANGED',
    );
    const peerRepositories = event.action === 'closed'
      ? await readWakePeers(targetHost) : [];
    const stateRoot = join(host.stateRoot, 'wake');
    await mkdir(stateRoot, { mode: 0o700 }).catch((error) => {
      if (error.code !== 'EEXIST') throw error;
    });
    await privateHostDirectory(stateRoot);
    return await dispatchIssueWake({
      reader,
      token,
      adoption,
      event,
      invocation: {
        repository: (runner.target ?? runner).repository,
        eventName: 'issues',
        runId: forwarded?.runId ?? runner.runId,
        attempt: forwarded ? 1 : runner.attempt,
        ...(shared ? { forwarded: true } : {}),
        coreCommit: host.installation.pin.commit,
      },
      stateRoot,
      peerRepositories,
      sharedRunner: shared ? adopted.runner : undefined,
      inspect: async () => {
        await inspect();
        if (event.action === 'closed')
          requireThat(
            digest(await readWakePeers(targetHost)) === digest(peerRepositories),
            'WAKE_PEERS_CHANGED');
      },
    });
  } catch {
    // The wake journal retains an uncertain dispatch for its source Issue.
    return { status: 'pending', code: 'HOST_WAKE_UNRESOLVED' };
  }
}
