import { GitHubReader, repoPath } from './github-read.mjs';
import { managerCredentialHost } from './managed-credential-host.mjs';
import { readPrivate } from './managed-credential-files.mjs';
import { withManagerAdmission } from './rollout-manager-admission.mjs';
import { managerHostRegistrations } from './shared-host-inspect.mjs';
import { currentPoolRuntime } from './core-only-runtime.mjs';
import { installationRoot } from './adopted-source-path.mjs';
import { readRetirementFile } from './retirement-files.mjs';
import { rolloutPlanPath, rolloutClosurePath } from './rollout-admission.mjs';
import { scheduleCoreMaintenance } from './core-maintenance-schedule.mjs';
import { requireThat } from './identity.mjs';
import { bindRolloutPool } from './rollout-pool.mjs';
import { isDeepStrictEqual } from 'node:util';

const operationReceipt = '/etc/nibfin/core-rollout-operation.json';

export function withUpgradeMember(context, memberId, action) {
  return withManagerAdmission(context, async () => {
    const managed = await managerCredentialHost(context);
    const token = (await readPrivate(managed.tokenFile, managed, 16384)).trim();
    const reader = new GitHubReader(token);
    const actor = await reader.get('/user');
    requireThat(actor.id === memberId && actor.type === 'User' &&
      /^[A-Za-z0-9-]+$/.test(actor.login), 'UPGRADE_MEMBER_CHANGED');
    return action(reader, token, actor);
  });
}

export async function scheduleAdministratorMaintenance(context, host, target) {
  const pool = managerHostRegistrations(host, context);
  const execution = { repository: pool.repository, repositoryId: pool.repositoryId };
  return withUpgradeMember(context, pool.memberId, async (reader, token, actor) => {
    const root = repoPath(execution.repository);
    const permission = await reader.get(
      `${root}/collaborators/${actor.login}/permission`);
    requireThat(permission.user?.id === actor.id && permission.permission === 'admin',
      'UPGRADE_CONSUMER_ADMIN_REQUIRED');
    const hasInstalled = async matches => {
      if (await readRetirementFile(rolloutPlanPath) ||
        await readRetirementFile(rolloutClosurePath)) return false;
      const current = await managerCredentialHost(context);
      if (!matches(current.installation.pin)) return false;
      return (await currentPoolRuntime(context)).directory === installationRoot;
    };
    const prior = await readRetirementFile(operationReceipt);
    if (isDeepStrictEqual(prior?.target, target) &&
      await hasInstalled(pin => isDeepStrictEqual(pin, prior.pin)))
      return { schemaVersion: 1, status: 'installed', installation: 'complete' };
    return scheduleCoreMaintenance(reader, token, execution, pool.memberId, target, {
      admit: () => bindRolloutPool(host, context),
      installed: ({ commit }) => hasInstalled(pin => pin.commit === commit),
    });
  });
}
