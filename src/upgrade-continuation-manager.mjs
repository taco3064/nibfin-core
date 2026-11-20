import { readFile } from 'node:fs/promises';
import { isId, requireThat } from './identity.mjs';
import { prepareUpgrade, bindUpgrade, observeUpgrade, matchedUpgrade, completeUpgrade,
  completeUpgradeWithoutProposal, completeDirectUpgrades, settleUpgradeContinuation,
  sameUpgradeSource,
  recordUnsupportedUpgradeActivation }
  from './upgrade-continuation-operations.mjs';
import { upgradeHostPorts } from './upgrade-continuation-host.mjs';
import { admitUpgradeInvocation, requireUpgradeInvocation }
  from './upgrade-continuation-identity.mjs';
import { exactUpgradeFields, upgradeOperationId }
  from './upgrade-continuation-contract.mjs';

async function requireLocalAdministrator(host, uid) {
  requireThat(uid !== host.runnerUid && uid !== host.sharedRunner.additionalRunner.uid &&
    !/nibfin-shared-runner@(?:1|2)\.service/.test(
      await readFile('/proc/self/cgroup', 'utf8')), 'UPGRADE_ADMINISTRATOR_REQUIRED');
}

export async function upgradeManagerRequest(context, host, supplied, uid, execute) {
  const ports = await upgradeHostPorts(context, host, execute);
  // The fixed bridge never exposes these post-install methods to its caller.
  if (supplied.kind === 'upgrade-installed') {
    exactUpgradeFields(supplied, ['kind', 'activation']);
    exactUpgradeFields(supplied.activation, ['runId', 'artifactId']);
    requireThat(isId(supplied.activation.runId) && isId(supplied.activation.artifactId),
      'UPGRADE_ACTIVATION_INVALID');
    return adoptMatchingUpgrades(ports, supplied.activation);
  }
  if (supplied.kind === 'upgrade-settle') {
    exactUpgradeFields(supplied, ['kind', 'operationId', 'result']);
    return settleUpgradeContinuation(upgradeOperationId(supplied.operationId),
      supplied.result, ports);
  }
  if (supplied.kind === 'upgrade-promotion-unsupported') {
    exactUpgradeFields(supplied, ['kind', 'activation']);
    return recordUnsupportedUpgradeActivation(supplied.activation, ports);
  }
  if (supplied.kind === 'upgrade-receive') {
    const scope = await ports.useReader(reader =>
      admitUpgradeInvocation(context, host, supplied, uid, reader));
    const invocation = requireUpgradeInvocation(scope, context);
    const operation = await matchedUpgrade(invocation.target, ports);
    requireThat(invocation.observed.actorId === operation.operation.memberId,
      'UPGRADE_EXECUTION_ACTOR_CHANGED');
    return completeUpgrade({ ...operation, observed: invocation.observed }, ports);
  }
  // CLI administrator calls come from outside the pool. Remote Worker input
  // can only reach the fixed receive operation above, never prepare or bind.
  await requireLocalAdministrator(host, uid);
  switch (supplied.kind) {
    case 'upgrade-prepare': return prepareUpgrade(supplied, ports);
    case 'upgrade-bind': return bindUpgrade(supplied, ports);
    case 'upgrade-observe': return observeUpgrade(supplied, ports);
    case 'upgrade-complete': return completeUpgradeWithoutProposal(supplied, ports);
    default: requireThat(false, 'UPGRADE_REQUEST_INVALID');
  }
}

// Existing Core CD completion invokes this only after the manager refreshes.
// Re-observe the exact native promotions and merged proposals; the advisory
// record cannot authorize a different source or another operation.
export async function adoptMatchingUpgrades(ports, activation) {
  const matching = (await ports.read()).filter(operation =>
    operation.promotionPending &&
    !(operation.progress.installation === 'installed' &&
      operation.progress.continuation === 'dispatched') &&
    operation.intent.activation?.runId === activation.runId &&
    operation.intent.activation?.artifactId === activation.artifactId);
  const operations = [];
  if (!matching.length)
    return { schemaVersion: 1, status: 'complete', upgradeOperations: operations };
  const current = await ports.adoption();
  for (const operation of matching) {
    requireThat(sameUpgradeSource(current.host.installation.pin, operation.intent.source),
      'UPGRADE_INSTALLED_SOURCE_CHANGED');
    const completed = [];
    for (const consumer of operation.consumers.filter(item => item.proposal?.merged)) {
      const binding = await matchedUpgrade(consumer.proposal, ports);
      const result = await completeUpgrade(binding, ports);
      completed.push(result.upgrade);
    }
    const direct = await completeDirectUpgrades(operation.id, ports,
      { allowNoEligible: true });
    if (direct) completed.push(direct.upgrade);
    const latest = completed.at(-1);
    operations.push(latest ? { ...latest, continuationEligible:
      completed.some(result => result.continuationEligible === true) &&
        ['ready', 'not-required'].includes(latest.readiness) } :
      { operationId: operation.id, installation: 'pending', readiness: 'pending',
        continuation: 'pending' });
  }
  return { schemaVersion: 1, status: 'complete', upgradeOperations: operations };
}
