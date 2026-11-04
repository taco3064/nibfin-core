import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { repoPath } from './github-read.mjs';
import { readRunnerBinding } from './runner-binding.mjs';
import { readProtectedApproval } from './github-approval.mjs';
import { actionsCaller } from './actions-identity.mjs';
import { readCurrentMain } from './current-main.mjs';
import { codexStageExecutor } from './codex-stage.mjs';
import { CandidateWorkspace } from './workspace.mjs';
import { command } from './process.mjs';
import { stages, evidenceBinding } from './stages.mjs';
import { EvidenceStore } from './evidence-store.mjs';
import { continueStages } from './stage-continuation.mjs';
import { setTimeout } from 'node:timers/promises';
import { digest, isId, requireThat } from './identity.mjs';
import { acquireHostFence, privateHostDirectory } from './host-fence.mjs';
import { pendingCIObservation } from './github-ci.mjs';

import { loadHostAdoption, inspectHostAdoption } from './host-adoption.mjs';
export { rootOwnedPath } from './host-adoption.mjs';

// Environment identifies candidates to read. Native job and signed OIDC checks
// below authenticate them; environment values never supply approval or a pin.
export async function resolveHostJob(
  reader,
  adopted,
  env,
  eventName = 'workflow_dispatch',
) {
  const runner = structuredClone(adopted.runner);
  const runId = Number(env.GITHUB_RUN_ID),
    attempt = Number(env.GITHUB_RUN_ATTEMPT);
  requireThat(
    isId(runId) &&
      isId(attempt) &&
      env.GITHUB_REPOSITORY === runner.repository &&
      ['workflow_dispatch', 'issues'].includes(eventName) &&
      env.GITHUB_EVENT_NAME === eventName &&
      env.RUNNER_ENVIRONMENT === 'self-hosted',
    'INVALID_HOST_CALLER',
  );
  const jobs = await reader.list(
    `${repoPath(runner.repository)}/actions/runs/${runId}/attempts/${attempt}/jobs`,
    'jobs',
  );
  const matches = jobs.filter(
    (job) =>
      job.name === runner.jobName &&
      job.runner_id === runner.runnerId &&
      job.runner_name === runner.runnerName &&
      job.status === 'in_progress',
  );
  requireThat(matches.length === 1, 'HOST_JOB_NOT_UNIQUE');
  const run = await reader.get(`${repoPath(runner.repository)}/actions/runs/${runId}`);
  Object.assign(runner, {
    runId,
    attempt,
    jobId: matches[0].id,
    actorId: run.actor?.id,
    sourceAnchor: adopted.runner.sourceCommit,
    sourceCommit: run.head_sha,
    eventName,
  });
  const binding = await readRunnerBinding(reader, runner);
  return { runner, binding };
}

export async function readSingleHost(reader, runner) {
  const registered = await reader.list(
    `${repoPath(runner.repository)}/actions/runners`,
    'runners',
  );
  const label = `nibfin-user-${runner.memberId}`;
  const matches = registered.filter(
    (item) =>
      Array.isArray(item.labels) && item.labels.some((value) => value.name === label),
  );
  requireThat(
    matches.length === 1 &&
      matches[0].id === runner.runnerId &&
      matches[0].name === runner.runnerName &&
      matches[0].status === 'online' &&
      matches[0].busy === true,
    'HOST_REGISTRATION_NOT_EXCLUSIVE',
  );
  return digest(matches);
}

export function hostExecution(runner, stage) {
  return nativeExecution(runner, stage, stages[stage].role);
}

export function hostWakeExecution(runner) {
  return nativeExecution(runner, 'wake', 'publisher');
}

function nativeExecution(runner, stage, role) {
  const native = {
    repositoryId: runner.repositoryId,
    runId: runner.runId,
    attempt: runner.attempt,
    jobId: runner.jobId,
    memberId: runner.memberId,
    sourceCommit: runner.sourceCommit,
    stage,
  };
  const uuid = (kind) => {
    const hash = digest({ kind, native });
    return [
      hash.slice(0, 8),
      hash.slice(8, 12),
      hash.slice(12, 16),
      hash.slice(16, 20),
      hash.slice(20, 32),
    ].join('-');
  };
  return {
    id: uuid('execution'),
    sessionId: uuid('session'),
    role,
    actorId: runner.memberId,
    runId: runner.runId,
    attempt: runner.attempt,
    jobId: runner.jobId,
  };
}

export async function idleContainers(profile) {
  const c = profile.agent;
  requireThat(
    c.docker === profile.hooks.docker && c.socket === profile.hooks.socket,
    'SPLIT_HOST_DAEMON',
  );
  const result = await command(
    c.docker,
    ['--host', `unix://${c.socket}`, 'ps', '--all', '--no-trunc', '--format', '{{.ID}}'],
    {
      env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent', DOCKER_CONFIG: '/nonexistent' },
      limit: 65536,
    },
  );
  const ids = result.stdout.toString().trim().split('\n').filter(Boolean).sort();
  requireThat(
    ids.length === 1 && ids[0] === c.gatewayId,
    'PREVIOUS_HOST_PROCESS_UNRESOLVED',
  );
  return digest(ids);
}

// Fixed CLI path: no config flag, environment override, adapter module, shell
// command, credential or execution identity can be provided by a request.
export async function launchStage(issueNumber, stage, env = process.env) {
  requireThat(
    /^[1-9][0-9]*$/.test(issueNumber) &&
      isId(Number(issueNumber)) &&
      typeof stage === 'string' &&
      (stage === 'continue' || Object.hasOwn(stages, stage)),
    'INVALID_STAGE_REQUEST',
  );
  const { host, hostBytes, adopted, token, reader } = await loadHostAdoption(issueNumber);
  const { runner, binding } = await resolveHostJob(reader, adopted, env);
  let execution = hostExecution(runner, stage === 'continue' ? 'shape' : stage);
  const caller = {
    pin: adopted.caller,
    requestUrl: env.ACTIONS_ID_TOKEN_REQUEST_URL,
    requestToken: env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
  };
  await actionsCaller({ ...caller, executionId: execution.id })(binding);
  const approval = await readProtectedApproval(reader, adopted.approval, Date.now());
  requireThat(
    approval.record.issue.number === Number(issueNumber) &&
      approval.record.issue.id === adopted.isolation.issue.id &&
      approval.record.roles[execution.role] === runner.memberId,
    'HOST_APPROVAL_MISMATCH',
  );
  // Stable host-wide lock survives cancellation/kill. No automatic stale-lock
  // deletion or switch to another Runner after an uncertain previous execution.
  let fence;
  try {
    fence = await acquireHostFence(host.stateRoot, {
      execution,
      host: digest(hostBytes),
    });
  } catch (error) {
    if (error.code === 'HOST_EXECUTION_UNRESOLVED')
      return { schemaVersion: 1, stage, status: 'pending', code: error.code };
    throw error;
  }
  try {
    const inspectWriter = async () => {
      await inspectHostAdoption({ host, hostBytes, adopted });
      return {
        executionId: execution.id,
        writerStatus: 'exclusive',
        observationHash: digest({
          fence: await fence.inspect(),
          containers: await idleContainers(adopted.isolation),
          registration: await readSingleHost(reader, runner),
        }),
      };
    };
    await inspectWriter();
    const root = join(
      host.stateRoot,
      `issue-${adopted.runner.repositoryId}-${issueNumber}`,
    );
    await mkdir(root, { mode: 0o700 }).catch((error) => {
      if (error.code !== 'EEXIST') throw error;
    });
    await privateHostDirectory(root);
    for (const name of ['receipts', 'agent']) {
      await mkdir(join(root, name), { mode: 0o700 }).catch((error) => {
        if (error.code !== 'EEXIST') throw error;
      });
      await privateHostDirectory(join(root, name));
    }
    const workspaceRoot = join(root, 'workspace');
    const store = new EvidenceStore(
      join(root, 'receipts'),
      evidenceBinding({ approval }),
    );
    const workspaceBinding = {
      kind: 'host-workspace',
      directory: workspaceRoot,
      binding: evidenceBinding({ approval }),
    };
    let fresh = false;
    try {
      await mkdir(workspaceRoot, { mode: 0o700 });
      fresh = true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    await privateHostDirectory(workspaceRoot);
    if (fresh) {
      const main = await readCurrentMain(reader, approval.record.issue);
      await new CandidateWorkspace(workspaceRoot, approval.record.issue).prepare(
        main.head,
      );
      await store.put(workspaceBinding);
    } else {
      requireThat(
        digest(await store.get(digest(workspaceBinding))) === digest(workspaceBinding),
        'WORKSPACE_ADOPTION_UNRESOLVED',
      );
    }
    const execute = async (current) => {
      execution = hostExecution(runner, current);
      requireThat(
        approval.record.roles[execution.role] === runner.memberId,
        'HOST_APPROVAL_MISMATCH',
      );
      const executor = await codexStageExecutor({
        installation: host.installation,
        caller,
        config: {
          approval: adopted.approval,
          runner,
          stateRoot: join(root, 'receipts'),
          ciWorkflows: adopted.ciWorkflows,
          reviewers: adopted.reviewers,
        },
        execution,
        workspaceRoot,
        agentStateRoot: join(root, 'agent'),
        authFile: host.authFile,
        model: host.model,
        isolation: adopted.isolation,
        inspectWriter,
        token,
      });
      return executor.run({ schemaVersion: 1, stage: current });
    };
    const result =
      stage === 'continue'
        ? await continueStages({
            store,
            execute,
            inspect: inspectWriter,
            wait: setTimeout,
          })
        : await execute(stage);
    if (result.status !== 'pending' || pendingCIObservation(result.code)) {
      await inspectWriter();
      await fence.release();
    }
    return stage === 'continue'
      ? {
          ...result,
          stage: 'continue',
          terminalStage: result.stage,
        }
      : result;
  } catch {
    // Do not turn partial preparation or an unknown container/write into a retry.
    return {
      schemaVersion: 1,
      stage,
      status: 'pending',
      code: 'HOST_EXECUTION_UNRESOLVED',
    };
  }
}
