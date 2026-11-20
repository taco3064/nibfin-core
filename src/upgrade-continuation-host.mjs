import { isDeepStrictEqual } from 'node:util';
import { join } from 'node:path';
import { rootOwnedPath } from './host-paths.mjs';
import { boundedHostFile, hostFile } from './host-adoption.mjs';
import { requireThat, isId } from './identity.mjs';
import { currentPoolRuntime } from './core-only-runtime.mjs';
import { GitHubReader } from './github-read.mjs';
import { managerCredentialHost } from './managed-credential-host.mjs';
import { readPrivate } from './managed-credential-files.mjs';
import { withManagerAdmission } from './rollout-manager-admission.mjs';
import { managerHostRegistrations } from './shared-host-inspect.mjs';
import { sharedRepository } from './shared-runner.mjs';
import { readRetirementFile, writeRetirementFile } from './retirement-files.mjs';
import { withCoreManagementGate } from './core-management-gate.mjs';
import { jobVmEnvironment } from './job-vm-readiness-host.mjs';
import { engine } from './engine-contract.mjs';
import { dispatchNativeWorkflow } from './native-workflow-dispatch.mjs';
import { maintenanceTarget } from './core-maintenance-dispatch.mjs';
import { upgradeRepository, observeUpgradeWorkflow, observeUpgradeProposal,
  observeUpgradeProposalDisposition, verifyUpgradeNotificationRoute }
  from './upgrade-continuation-proposals.mjs';
import { sameUpgradeSource, mergeUpgradeOperations }
  from './upgrade-continuation-operations.mjs';

const operationFile = '/etc/nibfin/upgrade-continuations.json';

export async function readUpgradeOperations() {
  const value = await readRetirementFile(operationFile);
  if (value === null) return [];
  requireThat(value.schemaVersion === 1 && Array.isArray(value.operations),
    'UPGRADE_OPERATION_STATE_INVALID');
  return value.operations;
}

export function writeUpgradeOperations(operations) {
  return writeRetirementFile(operationFile, { schemaVersion: 1, operations });
}

async function observeHost() {
  await rootOwnedPath(hostFile);
  return JSON.parse(await boundedHostFile(hostFile, 262144));
}

function observedValue(result, code) {
  let value;
  try { value = JSON.parse(result.bytes); }
  catch { requireThat(false, code); }
  requireThat(value && typeof value === 'object', code);
  return value;
}

function operationStore(shared) {
  let baseline;
  return {
    async read() {
      const current = await readUpgradeOperations();
      baseline = structuredClone(current);
      return current;
    },
    async write(next) {
      if (!shared) return writeUpgradeOperations(next);
      requireThat(baseline, 'UPGRADE_OPERATION_STATE_INVALID');
      const saved = await withCoreManagementGate(async () => {
        const current = await readUpgradeOperations();
        const merged = mergeUpgradeOperations(current, baseline, next);
        await writeUpgradeOperations(merged);
        return true;
      });
      const downgrade = await withCoreManagementGate(async () => true, { shared: true });
      requireThat(saved === true && downgrade === true,
        'CORE_MANAGEMENT_OPERATION_PENDING');
      baseline = structuredClone(next);
    },
  };
}

export async function upgradeHostPorts(context, host, execute, { shared = false } = {}) {
  const useReader = action => withManagerAdmission(context, async () => {
    const managed = await managerCredentialHost(context);
    const token = (await readPrivate(managed.tokenFile, managed, 16384)).trim();
    const reader = new GitHubReader(token);
    const actor = await reader.get('/user');
    requireThat(actor.id === host.memberId && actor.type === 'User' &&
      /^[A-Za-z0-9-]+$/.test(actor.login), 'UPGRADE_MEMBER_CHANGED');
    return action(reader, token, actor);
  });
  const adoption = async () => {
    const current = await observeHost();
    const pool = managerHostRegistrations(current, context);
    await context.verifyInstallation(current.installation.pin);
    const read = async path => {
      await rootOwnedPath(path);
      return JSON.parse(await boundedHostFile(path, 262144));
    };
    const consumers = await Promise.all(current.sharedRunner.repositories.map(
      async repositoryId => {
        const view = await sharedRepository(current, repositoryId, read);
        return { repositoryId, repository: view.repository.approval.repository };
      }));
    return { memberId: pool.memberId, consumers, host: current,
      execution: { repositoryId: pool.repositoryId, repository: pool.repository },
      runners: pool.runners };
  };
  const route = (operation, consumer) => useReader(async reader => {
    const execution = await upgradeRepository(reader, operation.execution);
    requireThat(execution.protected, 'UPGRADE_EXECUTION_BRANCH_UNPROTECTED');
    await verifyUpgradeNotificationRoute(reader, consumer, execution);
    await observeUpgradeWorkflow(reader, execution, 'execution', operation.memberId);
  });
  const runLive = async args => {
    const runtime = await currentPoolRuntime(context);
    requireThat(runtime.directory === '/opt/nibfin/core',
      'UPGRADE_INSTALLED_SOURCE_UNAVAILABLE');
    return execute(runtime.target.nodePath,
      [join(runtime.directory, 'bin/nibfin-core.mjs'), ...args], '');
  };
  return { adoption, useReader, route, ...operationStore(shared),
    sourceIntent: (intent, binding) => useReader(async (reader, _token, actor) => {
      for (const adopted of binding.consumers.filter(consumer =>
        intent.repositories.includes(consumer.repositoryId))) {
        const repo = await upgradeRepository(reader, adopted);
        const permission = await reader.get(
          `${repo.root}/collaborators/${actor.login}/permission`,
        );
        requireThat(permission.user?.id === actor.id && permission.permission === 'admin',
          'UPGRADE_CONSUMER_ADMIN_REQUIRED');
      }
      if (sameUpgradeSource(binding.host.installation.pin, intent.source)) return;
      await verifiedUpgradeActivation(reader, intent);
    }),
    proposal: (consumer, pullNumber, memberId) => useReader(reader =>
      observeUpgradeProposal(reader, consumer, pullNumber, memberId)),
    disposition: (consumer, proposal) => useReader(reader =>
      observeUpgradeProposalDisposition(reader, consumer, proposal)),
    noProposal: async (operation, consumer) => {
      await useReader(async reader => {
        const origin = await upgradeRepository(reader, consumer);
        await observeUpgradeWorkflow(reader, origin, 'notification', operation.memberId);
      });
      await route(operation, consumer);
    },
    readinessIdentity: async () => jobVmEnvironment(await observeHost()),
    async readiness(expected) {
      const assertCurrent = async () => {
        const current = await jobVmEnvironment(await observeHost());
        requireThat(isDeepStrictEqual(current, expected),
          'UPGRADE_READINESS_ENVIRONMENT_CHANGED');
      };
      await assertCurrent();
      const runtime = await currentPoolRuntime(context);
      requireThat(runtime.directory === '/opt/nibfin/core',
        'UPGRADE_INSTALLED_SOURCE_UNAVAILABLE');
      await rootOwnedPath('/usr/sbin/runuser');
      const entry = join(runtime.directory, 'src/job-vm-readiness-host.mjs');
      await rootOwnedPath(entry);
      const result = await execute('/usr/sbin/runuser',
        ['-u', engine.controller, '--', runtime.target.nodePath, entry], '');
      const value = observedValue(result, 'JOB_VM_READINESS_UNAVAILABLE');
      requireThat(result.code === 0 && value.status === 'ready',
        /^JOB_VM_[A-Z0-9_]+$/.test(value.code ?? '') ? value.code :
          'JOB_VM_READINESS_UNAVAILABLE');
      await assertCurrent();
    },
    async install(operation, binding, selected) {
      if (!sameUpgradeSource(binding.host.installation.pin, operation.intent.source))
        return requestCorePromotion(operation, useReader);
      const targets = selected ? [selected] : operation.consumers;
      for (const consumer of targets) {
        const result = await runLive(['refresh-managed-issue-caller',
          consumer.repository, String(consumer.repositoryId)]);
        const value = observedValue(result, 'UPGRADE_ADOPTION_READBACK_UNAVAILABLE');
        requireThat(result.code === 0 &&
          ['adopted', 'unchanged'].includes(value.status) &&
          value.repositoryId === consumer.repositoryId &&
          isDeepStrictEqual(value.runners, binding.runners),
        'UPGRADE_ADOPTION_READBACK_UNAVAILABLE');
      }
      return { status: 'installed' };
    },
    async cleanup() {
      // This existing operation proves all actual consumers migrated before
      // touching shared resources. Pending cleanup cannot prevent dispatch.
      const result = await runLive(['retire-notification-relay']);
      const value = observedValue(result, 'UPGRADE_CLEANUP_UNAVAILABLE');
      requireThat(['retired', 'pending'].includes(value.status),
        'UPGRADE_CLEANUP_UNAVAILABLE');
      return { status: value.status, ...(/^[A-Z][A-Z0-9_]*$/.test(value.code ?? '') ?
        { code: value.code } : {}) };
    },
  };
}

async function verifiedUpgradeActivation(reader, intent) {
  requireThat(intent.activation, 'UPGRADE_CORE_ACTIVATION_REQUIRED');
  const { runId, artifactId } = intent.activation;
  const root = '/repos/taco3064/nibfin-core';
  const [run, artifact, target] = await Promise.all([
    reader.get(`${root}/actions/runs/${runId}`),
    reader.get(`${root}/actions/artifacts/${artifactId}`),
    maintenanceTarget(reader, runId),
  ]);
  requireThat(run.id === runId && target.status === 'ready' &&
    target.artifactId === artifactId && artifact.id === artifactId &&
    artifact.expired === false && artifact.workflow_run?.id === runId &&
    artifact.name === `nibfin-activate-${intent.source.commit}` &&
    typeof run.created_at === 'string' && Number.isFinite(Date.parse(run.created_at)),
  'UPGRADE_CORE_ACTIVATION_CHANGED');
  return { runId, artifactId, since: new Date(run.created_at).toISOString() };
}

async function requestCorePromotion(operation, useReader) {
  return useReader(async (reader, token) => {
    const target = await verifiedUpgradeActivation(reader, operation.intent);
    const repository = await reader.get('/repos/taco3064/nibfin-core');
    const ref = repository.default_branch;
    requireThat(ref === 'main', 'UPGRADE_CORE_ACTIVATION_CHANGED');
    const path = '/repos/taco3064/nibfin-core/actions/workflows/core-maintenance.yml';
    const workflow = await reader.get(path);
    requireThat(workflow.path === '.github/workflows/core-maintenance.yml' &&
      isId(workflow.id) && workflow.state === 'active',
    'UPGRADE_CORE_ACTIVATION_CHANGED');
    const since = encodeURIComponent('>=' + target.since);
    const query = `event=workflow_dispatch&branch=main&created=${since}`;
    const runs = await reader.list(`${path}/runs?${query}`, 'workflow_runs');
    const matches = runs.filter(run =>
      isId(run.id) && run.workflow_id === workflow.id &&
      run.repository?.id === repository.id && run.head_repository?.id === repository.id &&
      run.display_title === `Core maintenance · CD ${target.runId}`);
    const active = matches.find(run => run.status !== 'completed');
    if (active) return { status: 'pending', coreRunId: active.id,
      code: 'UPGRADE_CORE_ACTIVATION_QUEUED' };
    const run = await dispatchNativeWorkflow({
      repository: 'taco3064/nibfin-core', ref, id: 'core-maintenance.yml',
    }, { cd_run_id: String(target.runId),
      activation_artifact_id: String(target.artifactId) }, token);
    return { status: 'pending', coreRunId: run.runId,
      code: 'UPGRADE_CORE_ACTIVATION_QUEUED' };
  });
}
