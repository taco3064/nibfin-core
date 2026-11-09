import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  loadHostAdoption,
  boundedHostFile,
  inspectHostAdoption,
} from './host-adoption.mjs';
import { acquireHostFence, privateHostDirectory } from './host-fence.mjs';
import {
  resolveHostJob,
  readSingleHost,
  idleContainers,
  hostWakeExecution,
} from './host-launcher.mjs';
import { actionsCaller } from './actions-identity.mjs';
import { readProtectedApproval } from './github-approval.mjs';
import { dispatchIssueWake } from './issue-wake.mjs';
import { digest, requireThat } from './identity.mjs';
import { relayHostCommand } from './host-relay.mjs';

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
  return {
    schemaVersion: 1,
    coreCommit: host.installation.pin.commit,
    eventWorkflow: workflow(event),
    issues: Object.values(host.issues).map((item) => ({
      approvalPin: item.approval,
      workflow: workflow(item.runner),
      actorId: host.memberId,
    })),
  };
}

// Fixed installed entry only. The hosted resolver supplies a locator, never
// token, storage, adapter, executable or authority configuration.
export async function launchIssueWake(issueNumber, env = process.env, eventBytes) {
  const relayed = await relayHostCommand('dispatch-event', [issueNumber], env);
  if (relayed !== null) return relayed;
  const context = await loadHostAdoption(issueNumber);
  const { host, hostBytes, adopted, reader, token } = context;
  const adoption = hostWakeAdoption(host, adopted);
  const { runner, binding } = await resolveHostJob(
    reader,
    { runner: adopted.eventRunner },
    env,
    'issues',
  );
  const execution = hostWakeExecution(runner);
  const authenticate = actionsCaller({
    pin: adopted.eventCaller,
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
  let fence;
  try {
    fence = await acquireHostFence(host.stateRoot, {
      execution,
      host: digest(hostBytes),
    });
  } catch (error) {
    if (error.code === 'HOST_EXECUTION_UNRESOLVED') {
      return { status: 'pending', code: error.code };
    }
    throw error;
  }
  try {
    const inspect = async () => {
      await inspectHostAdoption(context);
      const fresh = await resolveHostJob(
        reader,
        { runner: adopted.eventRunner },
        env,
        'issues',
      );
      await authenticate(fresh.binding);
      const current = await readProtectedApproval(reader, adopted.approval);
      requireThat(
        current.approvalHash === approval.approvalHash &&
          current.record.roles.publisher === runner.memberId &&
          current.record.operations.includes('wake'),
        'EVENT_AUTHORITY_CHANGED',
      );
      await fence.inspect();
      await idleContainers(adopted.isolation);
      await readSingleHost(reader, runner);
    };
    await inspect();
    requireThat(
      host.runnerUid === undefined || typeof eventBytes === 'string',
      'CONTROLLER_EVENT_TRANSPORT_REQUIRED',
    );
    const event = JSON.parse(
      eventBytes ?? (await boundedHostFile(env.GITHUB_EVENT_PATH, 1048576)),
    );
    requireThat(
      String(event.issue?.number) === issueNumber &&
        event.issue.node_id === approval.record.issue.id,
      'EVENT_ISSUE_CHANGED',
    );
    const stateRoot = join(host.stateRoot, 'wake');
    await mkdir(stateRoot, { mode: 0o700 }).catch((error) => {
      if (error.code !== 'EEXIST') throw error;
    });
    await privateHostDirectory(stateRoot);
    const result = await dispatchIssueWake({
      reader,
      token,
      adoption,
      event,
      invocation: {
        repository: runner.repository,
        eventName: 'issues',
        runId: runner.runId,
        attempt: runner.attempt,
        coreCommit: host.installation.pin.commit,
      },
      stateRoot,
      inspect,
    });
    if (result.status !== 'pending') {
      await idleContainers(adopted.isolation);
      await fence.release();
    }
    return result;
  } catch {
    // Unknown external effects retain the shared host fence and wake journal.
    return { status: 'pending', code: 'HOST_WAKE_UNRESOLVED' };
  }
}
