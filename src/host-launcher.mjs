import { localDeliverSettlement } from './local-deliver-settlement.mjs';
import { hostExecution } from './host-execution.mjs';
import { controllerRequestIdentity, recordControllerResult, resultObservation }
  from './controller-result.mjs';
import { retainHostOutcome } from './blocker-native-report.mjs';
import { requirePoolOpen } from './retirement-admission.mjs';
import { withManagedAdmission } from './managed-credential-admission.mjs';
import { ProjectConfigError } from './project-config.mjs';
import { reconcileDelivery } from './stage-reconciliation.mjs';
import { projectJob } from './project-job.mjs';
import { lstat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { repoPath } from './github-read.mjs';
import { readRunnerBinding } from './runner-binding.mjs';
import { readProtectedApproval } from './github-approval.mjs';
import { actionsCaller } from './actions-identity.mjs';
import { readCurrentMain } from './current-main.mjs';
import { hostMainReader } from './github-host-read.mjs';
import { installedProviderExecutor } from './installed-provider.mjs';
import { CandidateWorkspace } from './workspace.mjs';
import { stages, issueRequirementsChanged } from './stages.mjs';
import { issueProgress } from './issue-progress.mjs';
import { refreshShapeWorkspace } from './host-shape-workspace.mjs';
import { cleanClosedWorkspace } from './closed-workspace.mjs';
import { readReopenedDelivery } from './reopened-delivery.mjs';
import { continueStages } from './stage-continuation.mjs';
import { observeStageProgress } from './stage-presentation.mjs';
import { setTimeout } from 'node:timers/promises';
import { digest, isId, requireThat } from './identity.mjs';
import { issueStatePath, privateHostDirectory } from './host-fence.mjs';
import { idleContainers } from './host-containers.mjs';
import { idleIssueJobVms } from './job-vm.mjs';
import { OperationJournal } from './operation-journal.mjs';
import {
  settleHostStage, assertHostSettlement, hostPreparationSettlement,
} from './host-stage-settlement.mjs';
import {
  githubReadWait, observationFailureCode, retryGitHubObservation,
} from './observation-failure.mjs';
import { readHostStageInputs } from './host-stage-inputs.mjs';
import { prepareHostJobMcp } from './mcp-job-host.mjs';
import { settleMcpJobCopies } from './mcp-copy-settlement.mjs';

import {
  loadHostAdoption, inspectHostAdoption,
} from './host-adoption.mjs';
import { relayHostCommand } from './host-relay.mjs';
import { targetContextKey } from './controller-contract.mjs';
export { rootOwnedPath } from './host-adoption.mjs';
export { hostExecution, hostWakeExecution } from './host-execution.mjs';

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

// Fixed CLI path: no config flag, environment override, adapter module, shell
// command, credential or execution identity can be provided by a request.
function requireStageRequest(issueNumber, stage) {
  requireThat(
    /^[1-9][0-9]*$/.test(issueNumber) &&
      isId(Number(issueNumber)) &&
      typeof stage === 'string' &&
      (stage === 'continue' || Object.hasOwn(stages, stage)),
    'INVALID_STAGE_REQUEST',
  );
}

export async function launchStage(issueNumber, stage, env = process.env, runnerUid) {
  requireStageRequest(issueNumber, stage);
  const relayed = await relayHostCommand('stage', [issueNumber, stage], env);
  if (relayed !== null) return relayed;
  return withManagedAdmission(() => launchAdmittedStage(
    issueNumber, stage, env, runnerUid), { pool: true });
}

export async function reconcileStage(issueNumber, stage, env, runnerUid) {
  requireStageRequest(issueNumber, stage);
  return withManagedAdmission(() => launchAdmittedStage(
    issueNumber, stage, env, runnerUid, true), { pool: true });
}

async function launchAdmittedStage(issueNumber, stage, env, runnerUid,
  reconcile = false) {
  let initial;
  try {
    initial = await retryGitHubObservation(async () => {
      const target = env[targetContextKey];
      const context = await loadHostAdoption(issueNumber, target, runnerUid);
      const { reader, adopted } = context;
      const job = await resolveHostJob(reader, adopted, env);
      const approval = await readProtectedApproval(reader, adopted.approval);
      return { context, job, approval };
    });
  } catch (error) {
    const waiting = githubReadWait(error, undefined, { stage: true });
    if (!waiting) throw error;
    return { schemaVersion: 1, stage, ...waiting,
      ...(!reconcile && stage === 'continue' && env[targetContextKey] ? {
        retrySettled: true,
        retryRun: Number(env.GITHUB_RUN_ID),
        retryAttempt: Number(env.GITHUB_RUN_ATTEMPT),
      } : {}) };
  }
  const { context, job: { runner, binding }, approval } = initial;
  const { host, adopted, token, reader, targetHost } = context;
  // The target repository's host profile controls whether a shared job uses MCP.
  const mcpSource = (targetHost ?? host).mcp;
  let execution = hostExecution(runner, stage === 'continue' ? 'shape' : stage);
  const caller = {
    pin: adopted.caller,
    requestUrl: env.ACTIONS_ID_TOKEN_REQUEST_URL,
    requestToken: env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
  };
  await actionsCaller({ ...caller, executionId: execution.id })(binding);
  requireThat(
    approval.record.issue.number === Number(issueNumber) &&
      approval.record.issue.id === adopted.isolation.issue.id &&
      approval.record.roles[execution.role] === runner.memberId,
    'HOST_APPROVAL_MISMATCH',
  );
  if (reconcile) {
    return reconcileDelivery({
      context, runner, approval, stage, execution,
      closeExecution: hostExecution(runner, 'close'),
    });
  }
  const issue = approval.record.issue;
  const request = controllerRequestIdentity(issue, runner, stage, execution);
  const root = issueStatePath(host.stateRoot, issue);
  const inputs = await readHostStageInputs(context, { approval, runner, execution },
    stage);
  if (inputs.outcome) return inputs.outcome;
  const { proposal, globalInstructions } = inputs;
  await mkdir(root, { mode: 0o700 }).catch((error) => {
    if (error.code !== 'EEXIST') throw error;
  });
  await privateHostDirectory(root);
  // GitHub admits one native Job for this Issue. Local state is evidence of
  // previous work; only live resources or unresolved effects need settlement.
  const localSettlement = localDeliverSettlement();
  let mcpJob, release, preparation;
  let mcpEntered = false, executorEntered = false;
  let progress, producer, observed;
  try {
    const idleIssue = async () => {
      if (host.jobVm) await idleIssueJobVms(root);
      return idleContainers(adopted.isolation, issue);
    };
    const inspectWriter = async (_stage, observed) => {
      await inspectHostAdoption(context);
      const registration = observed?.runner?.runnerId === runner.runnerId
        ? observed.runner.observationHash : await readSelectedHost(reader, runner);
      return {
        executionId: execution.id,
        writerStatus: 'exclusive',
        observationHash: digest({
          containers: await idleIssue(),
          registration,
        }),
      };
    };
    await mkdir(join(root, 'receipts'), { mode: 0o700 }).catch(error => {
      if (error.code !== 'EEXIST') throw error;
    });
    await privateHostDirectory(join(root, 'receipts'));
    const openPr = (context.targetHost ?? host).openPrHandoffs?.[issueNumber];
    const journal = new OperationJournal(join(root, 'receipts'), approval.record.issue);
    release = async (result) => {
      // Preserve results only after local termination and external writes settle.
      await assertHostSettlement(journal, idleIssue);
      await mcpJob?.retire(true);
      if (progress) {
        await recordControllerResult({ ...progress, request, producer, result,
          observed })
          .catch(() => report('retention', 'CONTROLLER_RESULT_UNAVAILABLE'));
      }
      if (progress && ((result.stage === 'close' && result.status === 'completed') ||
          result.code === 'DELIVERY_ALREADY_RECORDED')) {
        await cleanClosedWorkspace({ progress, approval, reader }).catch(() => {
          console.error('Nibfin retained the closed Issue work directory');
        });
      }
    };
    const report = (phase, code) =>
      console.error(`Nibfin host stage ${phase}: ${code}`);
    preparation = hostPreparationSettlement(execution, release, report);
    // Only filesystem preparation and receipt reads precede this boundary.
    // Establish all settlement dependencies before admitting these failures.
    await mkdir(join(root, 'agent'), { mode: 0o700 }).catch(error => {
      if (error.code !== 'EEXIST') throw error;
    });
    await privateHostDirectory(join(root, 'agent'));
    progress = await issueProgress(root, approval);
    // Invalidate the previous result before any work of this request can run.
    await progress.store.replaceControllerResult(null);
    // Adoption/container inspection itself can launch host commands. A failed
    // observation does not prove those processes stopped. Everything beyond
    // this checkpoint stays unclassified without its normal lifecycle proof.
    preparation.enterOwnedWork();
    await retryGitHubObservation(inspectWriter);
    await journal.retireStoppedLease();
    if (openPr) await journal.assertIdle();
    if (!await settleMcpJobCopies(root)) {
      // A previous Job copy may still have a consumer. Keep it and run nothing:
      // release is deliberately skipped, so no retirement or cleanup happens.
      return retainHostOutcome(root, { approval, runner, execution }, stage, {
        schemaVersion: 1, stage, status: 'pending',
        code: 'MCP_JOB_TERMINATION_UNPROVEN',
      });
    }
    const { workspaceRoot, binding, store, marker: workspaceBinding } = progress;
    const workspace = new CandidateWorkspace(workspaceRoot, issue);
    let observedMain;
    let resumeClosed = false;
    const observeMain = () => observedMain ??= retryGitHubObservation(() =>
      readCurrentMain(reader, issue, hostMainReader(token), approval.repository));
    const requirementsChanged = async receipts => {
      if (!receipts.shape) return false;
      const current = await reader.issue(issue);
      if (await issueRequirementsChanged(current, receipts, hash => store.get(hash)))
        return true;
      const publication = receipts['commit-pr']?.artifacts;
      if (current.state === 'open' && publication && !receipts.merge) {
        const pr = await reader.get(`${repoPath(issue.repository)}/pulls/` +
          publication.prNumber);
        requireThat(pr.node_id === publication.prId &&
          pr.base?.repo?.id === issue.repositoryId, 'PR_RECEIPT_IDENTITY_CHANGED');
        if (pr.state === 'closed' && pr.merged === false) return true;
      }
      const reopened = await readReopenedDelivery({
        reader, issue, live: current, receipts, observeMain,
      });
      if (reopened.recoveredMerge) await store.append(reopened.recoveredMerge);
      resumeClosed = reopened.reconcile ? { schemaVersion: 1, stage: 'continue',
        status: 'pending', code: 'CONTROLLER_RECONCILIATION_UNPROVEN' }
        : reopened.close;
      return reopened.changed;
    };
    const existing = await lstat(workspaceRoot).catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    const main = existing ? null : await observeMain();
    let restartedShape = null;
    let observedRequirements;
    let fresh = false;
    try {
      await mkdir(workspaceRoot, { mode: 0o700 });
      fresh = true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    await privateHostDirectory(workspaceRoot);
    if (fresh) {
      requireThat(main, 'WORKSPACE_ADOPTION_UNRESOLVED');
      await workspace.prepare(main.head);
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
      if (stage === 'continue' || stage === 'shape') {
        const receipts = await store.load();
        restartedShape = await refreshShapeWorkspace({
          workspace, stage, receipts, openPr, observeMain,
          requirementsChanged: async () => {
            const changed = await retryGitHubObservation(() =>
              requirementsChanged(receipts));
            observedRequirements = { shape: digest(receipts.shape), changed };
            return changed;
          },
          settle: async () => {
            await journal.assertIdle();
            await retryGitHubObservation(inspectWriter);
          },
        });
      }
    }
    const composeStage = await projectJob({
      workspace, runner, issue, observeMain,
      jobVm: host.jobVm && {
        ...host.jobVm, stateRoot: root, pressureRoot: host.stateRoot,
      },
    }, installedProviderExecutor(host));
    if (!proposal) {
      mcpEntered = true;
      mcpJob = await prepareHostJobMcp({
        host: { ...host, mcp: mcpSource }, issueRoot: root, runner, reader,
        approval,
      }, {
        authorize: async () => {
          const fresh = await retryGitHubObservation(() =>
            readProtectedApproval(reader, adopted.approval));
          requireThat(fresh.approvalHash === approval.approvalHash,
            'HOST_APPROVAL_MISMATCH');
        },
      });
    }
    const invocations = new Map();
    const presentation = observeStageProgress(async (current, ciFailure) => {
      await requirePoolOpen();
      const iteration = invocations.get(current) ?? 0;
      invocations.set(current, iteration + 1);
      execution = hostExecution(runner, current, iteration);
      producer = { stage: current, iteration, execution };
      observed = null;
      requireThat(
        approval.record.roles[execution.role] === runner.memberId,
        'HOST_APPROVAL_MISMATCH',
      );
      const settlement = localSettlement.invocation(current, execution);
      executorEntered = true;
      let executor;
      try {
        executor = await composeStage({
          installation: host.installation,
          caller,
          config: {
            approval: adopted.approval,
            runner,
            continuation: stage === 'continue',
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
          settlement,
          workspaceRoot,
          workflowNodeId: binding.workflowNodeId,
          agentStateRoot: join(root, 'agent'),
          authFile: host.authFile,
          mcpSource: proposal ? undefined : mcpSource,
          proposal,
          globalInstructions,
          mcpJob,
          model: host.model,
          isolation: adopted.isolation,
          inspectWriter,
          observeResult: context => { observed = resultObservation(context); },
          token,
        });
      } catch (error) {
        // Composition may have started tools without returning their handle.
        // A transport error or a read-wait diagnostic cannot prove retirement.
        return { schemaVersion: 1, stage: current, status: 'pending',
          code: observationFailureCode(error) };
      }
      return executor.run({ schemaVersion: 1, stage: current });
    });
    const { execute } = presentation;
    const run = () =>
      stage === 'continue'
        ? continueStages({
            store,
            execute,
            saveDeliverCheckpoint: true,
            resumeClosed: async () => resumeClosed,
            refreshRequirements: async receipts => {
              if (!receipts.shape) return false;
              const shape = digest(receipts.shape);
              if (shape === restartedShape) return true;
              if (shape === observedRequirements?.shape)
                return observedRequirements.changed;
              return requirementsChanged(receipts);
            },
            inspect: inspectWriter,
            wait: setTimeout,
          })
        : execute(stage);
    const settled = await settleHostStage(run, release,
      report, () => localSettlement.assertSettled());
    const result = await retainHostOutcome(root, { approval, runner, execution },
      settled.stage ?? stage, settled);
    return stage === 'continue'
      ? {
          ...result,
          stageProgress: presentation.progress,
          stage: 'continue',
          terminalStage: result.stage,
          ...(result.retrySettled && runner.target ? {
            retryRun: runner.runId, retryAttempt: runner.attempt,
          } : {}),
        }
      : { ...result, stageProgress: presentation.progress };
  } catch (error) {
    const waiting = githubReadWait(error, undefined, { stage: true });
    if (waiting && release && !mcpEntered && !executorEntered) {
      const result = await settleHostStage(async () => ({
        schemaVersion: 1, stage, ...waiting,
      }), release, (phase, code) => console.error(`Nibfin host stage ${phase}: ${code}`));
      return { ...result, ...(result.retrySettled && runner.target ? {
        retryRun: runner.runId, retryAttempt: runner.attempt,
      } : {}) };
    }
    if (error instanceof ProjectConfigError && !mcpEntered && !executorEntered) {
      // No role has started. Still prove prior writes and containers settled
      // before retiring prepared MCP resources and allowing a corrected retry.
      return await settleHostStage(async () => ({
        schemaVersion: 1, stage, status: 'denied', code: error.code,
        configurationError: error.message,
      }), release,
      (phase, code) => console.error(`Nibfin host stage ${phase}: ${code}`));
    }
    // Do not turn partial preparation or an unknown container/write into a retry.
    const result = {
      schemaVersion: 1,
      stage,
      status: 'pending',
      code: observationFailureCode(error),
    };
    const settled = preparation ? await preparation.settle(result) : result;
    return retainHostOutcome(root, { approval, runner, execution }, stage,
      settled);
  } finally { mcpJob?.stop(); }
}
