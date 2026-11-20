import contract from './upgrade-continuation-contract.json' with { type: 'json' };
import recipes from './upgrade-continuation-recipes.json' with { type: 'json' };
import { isId, requireThat } from './identity.mjs';
import { isInstallationPin } from './source-package.mjs';

export const upgradeContinuationContract = Object.freeze(contract);

export function exactUpgradeFields(value, fields) {
  requireThat(value && Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).length === fields.length &&
    fields.every(field => Object.hasOwn(value, field)), 'UPGRADE_REQUEST_INVALID');
  return value;
}

export function upgradeOperationId(value) {
  requireThat(typeof value === 'string' &&
    /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value),
  'UPGRADE_OPERATION_INVALID');
  return value;
}

export function upgradeExecutionTarget(value) {
  exactUpgradeFields(value, ['repositoryId', 'pullNumber']);
  requireThat(isId(value.repositoryId) && isId(value.pullNumber),
    'UPGRADE_PROPOSAL_LOCATOR_INVALID');
  return value;
}

export function upgradePreparation(value) {
  exactUpgradeFields(value, ['kind', 'repositories', 'source', 'activation']);
  requireUpgradeRepositories(value.repositories);
  exactUpgradeFields(value.source, ['repository', 'commit', 'manifestHash']);
  requireThat(isInstallationPin(value.source), 'UPGRADE_SOURCE_INVALID');
  if (value.activation !== null) {
    exactUpgradeFields(value.activation, ['runId', 'artifactId']);
    requireThat(isId(value.activation.runId) && isId(value.activation.artifactId),
      'UPGRADE_ACTIVATION_INVALID');
  }
  return value;
}

export function upgradeBinding(value) {
  exactUpgradeFields(value, ['kind', 'operationId', 'repositoryId', 'pullNumber']);
  upgradeOperationId(value.operationId);
  const { repositoryId, pullNumber } = value;
  upgradeExecutionTarget({ repositoryId, pullNumber });
  return value;
}

export function upgradeObservation(value) {
  exactUpgradeFields(value, ['kind', 'operationId']);
  upgradeOperationId(value.operationId);
  return value;
}

export function upgradeCompletion(value) {
  if (!Object.hasOwn(value ?? {}, 'repositories')) return upgradeObservation(value);
  exactUpgradeFields(value, ['kind', 'operationId', 'repositories']);
  upgradeOperationId(value.operationId);
  requireUpgradeRepositories(value.repositories);
  return value;
}

function requireUpgradeRepositories(repositories) {
  requireThat(Array.isArray(repositories) && repositories.length > 0 &&
    repositories.every(isId) && new Set(repositories).size === repositories.length,
  'UPGRADE_REPOSITORIES_INVALID');
}

// Existing caller-recipes.json has strict consumers. Upgrade uses its own
// table, with bytes validated at the separately authorized receiver boundary.
export function upgradeRecipe(kind, memberId) {
  requireThat(Object.hasOwn(recipes, kind) &&
    (kind !== 'execution' || isId(memberId)), 'UPGRADE_RECIPE_INVALID');
  return recipes[kind].join('\n').replaceAll('MEMBER_ID', String(memberId ?? ''));
}

export function upgradeRecipeVariants(kind, memberId) {
  const current = upgradeRecipe(kind, memberId);
  const original = current.split('\n').filter(line => !line.startsWith('run-name: '));
  return [current, original.join('\n')];
}
