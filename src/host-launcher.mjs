import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { repoPath } from './github-read.mjs';
import { readRunnerBinding } from './runner-binding.mjs';
import { readProtectedApproval } from './github-approval.mjs';
import { actionsCaller } from './actions-identity.mjs';
import { readCurrentMain } from './current-main.mjs';
import { hostMainReader } from './github-host-read.mjs';
import { codexStageExecutor } from './codex-stage.mjs';
import { CandidateWorkspace } from './workspace.mjs';
import { stages, issueRequirementsChanged } from './stages.mjs';
import { issueProgress } from './issue-progress.mjs';
import { continueStages } from './stage-continuation.mjs';
import { setTimeout } from 'node:timers/promises';
import { digest, isId, requireThat } from './identity.mjs';
import { acquireHostFence, issueStatePath, privateHostDirectory } from './host-fence.mjs';
import { idleContainers } from './host-containers.mjs';
import { OperationJournal } from './operation-journal.mjs';
import { settleHostStage } from './host-stage-settlement.mjs';
import {
  observationFailureCode, retryGitHubObservation,
} from './observation-failure.mjs';
import { readNotionProposal } from './notion-proposal.mjs';
import { prepareHostJobMcp } from './mcp-job-host.mjs';

import {
  loadHostAdoption, inspectHostAdoption, readGlobalInstructions,
} from './host-adoption.mjs';
import { relayHostCommand } from './host-relay.mjs';
import { targetContextKey } from './controller-contract.mjs';
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
    nativePolicy: adopted.approval?.kind === 'repository-admission-v1',
    eventName,
  });
  if (runner.target) requireThat(runner.actorId === runner.memberId,
    'SHARED_DISPATCH_ACTOR_MISMATCH');
  const binding = await readRunnerBinding(reader, runner);
  return { runner, binding };
}

export async function readSelectedHost(reader, runner) {
  const registered = await reader.list(
    `${repoPath(runner.repository)}/actions/runners`,
    'runners',
  );
  const label = `nibfin-user-${runner.memberId}`;
  const matches = registered.filter(
    (item) =>
      item.id === runner.runnerId && item.name === runner.runnerName &&
      Array.isArray(item.labels) && item.labels.some((value) => value.name === label),
  );
  requireThat(
    matches.length === 1 &&
      matches[0].status === 'online' &&
      matches[0].busy === true,
    'HOST_REGISTRATION_MISMATCH',
  );
  return digest(matches);
}

export function hostExecution(runner, stage, iteration = 0) {
  return nativeExecution(runner, stage, stages[stage].role, iteration);
}

export function hostWakeExecution(runner) {
  return nativeExecution(runner, 'wake', 'publisher');
}

function nativeExecution(runner, stage, role, iteration = 0) {
  const native = {
    repositoryId: runner.repositoryId,
    runId: runner.runId,
    attempt: runner.attempt,
    jobId: runner.jobId,
    memberId: runner.memberId,
    sourceCommit: runner.sourceCommit,
    stage,
    ...(iteration ? { iteration } : {}),
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
  const relayed = await relayHostCommand('stage', [issueNumber, stage], env);
  if (relayed !== null) return relayed;
  const context = await loadHostAdoption(issueNumber, env[targetContextKey]);
  const { host, hostBytes, adopted, token, reader } = context;
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
  // An adopted Proposal-only Issue uses a controller read in place of MCP.
  // Complete this read before taking the fence, since it has no write effect.
  const proposal = adopted.notionProposal === undefined ? undefined :
    await readNotionProposal(adopted.notionProposal);
  const globalInstructions = await readGlobalInstructions(host);
  const issue = approval.record.issue;
  const root = issueStatePath(host.stateRoot, issue);
  await mkdir(root, { mode: 0o700 }).catch((error) => {
    if (error.code !== 'EEXIST') throw error;
  });
  let fence;
  try {
    fence = await acquireHostFence(root, {
      execution,
      issueId: issue.id,
      host: digest(hostBytes),
    });
  } catch (error) {
    if (error.code === 'HOST_EXECUTION_UNRESOLVED')
      return { schemaVersion: 1, stage, status: 'pending', code: error.code };
    throw error;
  }
  let mcpJob;
  try {
    const inspectWriter = async () => {
      await inspectHostAdoption(context);
      return {
        executionId: execution.id,
        writerStatus: 'exclusive',
        observationHash: digest({
          fence: await fence.inspect(),
          containers: await idleContainers(adopted.isolation, issue),
          registration: await readSelectedHost(reader, runner),
        }),
      };
    };
    await inspectWriter();
    if (!proposal) mcpJob = await prepareHostJobMcp({ host, runner, reader, approval }, {
      authorize: async () => {
        const fresh = await readProtectedApproval(reader, adopted.approval);
        requireThat(fresh.approvalHash === approval.approvalHash,
          'HOST_APPROVAL_MISMATCH');
      },
    });
    for (const name of ['receipts', 'agent']) {
      await mkdir(join(root, name), { mode: 0o700 }).catch((error) => {
        if (error.code !== 'EEXIST') throw error;
      });
      await privateHostDirectory(join(root, name));
    }
    const openPr = (context.targetHost ?? host).openPrHandoffs?.[issueNumber];
    const journal = new OperationJournal(join(root, 'receipts'), approval.record.issue);
    if (openPr) await journal.assertIdle();
    const { workspaceRoot, binding, store, marker: workspaceBinding } =
      await issueProgress(root, approval);
    let fresh = false;
    try {
      await mkdir(workspaceRoot, { mode: 0o700 });
      fresh = true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    await privateHostDirectory(workspaceRoot);
    if (fresh) {
      const main = await retryGitHubObservation(() =>
        readCurrentMain(reader, approval.record.issue,
          hostMainReader(token), approval.repository));
      await new CandidateWorkspace(workspaceRoot, approval.record.issue).prepare(
        main.head,
      );
      await store.put(workspaceBinding);
    } else {
      const previous = await store.get(digest(workspaceBinding)).catch(error => {
        if (error.code !== 'ENOENT') throw error;
        return null;
      });
      requireThat(
        previous && digest(previous) === digest(workspaceBinding),
        'WORKSPACE_ADOPTION_UNRESOLVED',
      );
    }
    const invocations = new Map();
    const execute = async (current, ciFailure) => {
      const iteration = invocations.get(current) ?? 0;
      invocations.set(current, iteration + 1);
      execution = hostExecution(runner, current, iteration);
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
          stateBinding: binding,
          hostGitHubReads: true,
          pauseJournalRoot: join(host.stateRoot, 'wake'),
          ciWorkflows: adopted.ciWorkflows,
          ...(ciFailure ? { ciFailure } : {}),
          reviewers: adopted.reviewers,
          ...(openPr ? { openPr } : {}),
        },
        execution,
        workspaceRoot,
        agentStateRoot: join(root, 'agent'),
        authFile: host.authFile,
        mcpSource: proposal ? undefined : host.mcp,
        proposal,
        globalInstructions,
        mcpJob,
        model: host.model,
        isolation: adopted.isolation,
        inspectWriter,
        token,
      });
      return executor.run({ schemaVersion: 1, stage: current });
    };
    const run = () =>
      stage === 'continue'
        ? continueStages({
            store,
            execute,
            refreshRequirements: async receipts => {
              if (!receipts.shape || receipts.merge) return false;
              const issue = await reader.issue(approval.record.issue);
              return issueRequirementsChanged(issue, receipts, hash => store.get(hash));
            },
            inspect: inspectWriter,
            wait: setTimeout,
          })
        : execute(stage);
    const result = await settleHostStage(run, async () => {
      // Release only after local termination and external writes are settled.
      await journal.assertIdle();
      await idleContainers(adopted.isolation, issue);
      await mcpJob?.retire(true);
      await fence.release();
    }, (phase, code) => console.error(`Nibfin host stage ${phase}: ${code}`));
    return stage === 'continue'
      ? {
          ...result,
          stage: 'continue',
          terminalStage: result.stage,
        }
      : result;
  } catch (error) {
    // Do not turn partial preparation or an unknown container/write into a retry.
    return {
      schemaVersion: 1,
      stage,
      status: 'pending',
      code: observationFailureCode(error),
    };
  } finally { mcpJob?.stop(); }
}
