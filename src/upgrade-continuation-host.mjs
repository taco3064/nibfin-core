import { isDeepStrictEqual } from 'node:util';
import { join } from 'node:path';
import { rootOwnedPath } from './host-paths.mjs';
import { boundedHostFile, hostFile } from './host-adoption.mjs';
import { requireThat } from './identity.mjs';
import { currentPoolRuntime } from './core-only-runtime.mjs';
import { managerHostRegistrations } from './shared-host-inspect.mjs';
import { sharedRepository } from './shared-runner.mjs';
import { upgradeOperationStore } from './upgrade-operation-store.mjs';
import { jobVmEnvironment } from './job-vm-readiness-host.mjs';
import { engine } from './engine-contract.mjs';
import { maintenanceTarget } from './core-maintenance-dispatch.mjs';
import { scheduleCoreMaintenance } from './core-maintenance-schedule.mjs';
import { withUpgradeMember } from './core-maintenance-schedule-host.mjs';
import { upgradeRepository, observeUpgradeWorkflow, observeUpgradeProposal,
  observeUpgradeProposalDisposition, verifyUpgradeNotificationRoute }
  from './upgrade-continuation-proposals.mjs';
import { sameUpgradeSource } from './upgrade-continuation-operations.mjs';
import { requireRolloutEnrollments } from './rollout-pool.mjs';

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

export async function upgradeHostPorts(context, host, execute) {
  const useReader = action => withUpgradeMember(context, host.memberId, action);
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
  return { adoption, useReader, route, ...upgradeOperationStore(),
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
        return requestCorePromotion(operation, binding, useReader);
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

async function requestCorePromotion(operation, binding, useReader) {
  return useReader(async (reader, token) => {
    requireRolloutEnrollments(binding.consumers);
    const target = await verifiedUpgradeActivation(reader, operation.intent);
    return scheduleCoreMaintenance(reader, token, operation.execution,
      operation.memberId, target);
  });
}
