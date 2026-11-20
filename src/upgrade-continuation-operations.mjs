import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { requireThat } from './identity.mjs';
import { githubReadDiagnostic } from './github-read-cause.mjs';
import { workflowDispatchFailure } from './native-workflow-dispatch.mjs';
import { upgradePreparation, upgradeBinding, upgradeObservation, upgradeCompletion }
  from './upgrade-continuation-contract.mjs';

const initial = () => ({
  handoff: 'pending', installation: 'pending', readiness: 'pending',
  continuation: 'pending',
});

function confirmHandoff(operation) {
  if (operation.consumers.every(item => item.directVerified ||
    item.proposal?.handoff === 'confirmed')) operation.progress.handoff = 'confirmed';
}

function reply(operation, extra = {}) {
  const proposals = operation.consumers.flatMap(({ proposal }) =>
    proposal ? [proposal] : []);
  const consumers = operation.consumers.map(consumer => ({
    repository: consumer.repository, repositoryId: consumer.repositoryId,
    installation: consumer.adopted ? 'installed' : 'pending',
    handoff: consumer.proposal?.handoff ??
      (consumer.directVerified ? 'confirmed' : 'pending'),
    ...(consumer.installationCause ? { cause: consumer.installationCause } : {}),
  }));
  return { schemaVersion: 1, status: 'complete', upgrade: {
    operationId: operation.id,
    executionRepository: operation.execution.repository,
    executionRepositoryId: operation.execution.repositoryId,
    proposals, consumers, ...operation.progress, ...(operation.coreRunId ?
      { coreRunId: operation.coreRunId } : {}), ...extra,
  } };
}

function sameIntent(left, right) {
  return isDeepStrictEqual(left, right);
}

function sameProposal(left, right) {
  return left?.pullId === right.pullId && left.pullNodeId === right.pullNodeId &&
    left.pullNumber === right.pullNumber && left.repositoryId === right.repositoryId;
}

export function upgradeSourcePin(pin) {
  const { repository, commit, manifestHash } = pin;
  return { repository, commit, manifestHash };
}

export function sameUpgradeSource(left, right) {
  return sameIntent(upgradeSourcePin(left), upgradeSourcePin(right));
}

// Existing management admission serializes the write, not the VM or provider
// observations. Reconcile unrelated operations and preserve changed approvals.
export function mergeUpgradeOperations(current, initial, next) {
  const changes = new Map(next.flatMap(value => {
    const before = initial.find(previous => previous.id === value.id);
    if (sameIntent(before, value)) return [];
    const observed = current.find(existing => existing.id === value.id);
    requireThat(sameIntent(observed, before), 'UPGRADE_OPERATION_CHANGED');
    return [[value.id, value]];
  }));
  const merged = current.map(value => {
    const update = changes.get(value.id);
    changes.delete(value.id);
    return update ?? value;
  });
  return [...merged, ...changes.values()];
}

async function priorUpgrade(records, binding, intent, ports) {
  const sameSource = records.filter(record => record.memberId === binding.memberId &&
    sameIntent(record.execution, binding.execution) &&
    sameUpgradeSource(record.intent.source, intent.source));
  const candidates = sameSource.filter(record =>
    sameIntent(record.intent.repositories, intent.repositories));
  const exact = candidates.find(record =>
    sameIntent(record.intent.activation, intent.activation));
  if (exact || intent.activation !== null ||
    !sameUpgradeSource(binding.host.installation.pin, intent.source)) return exact;
  // A completed promotion no longer needs activation to prove current source.
  // Recover the original intent rather than requiring its old CD artifact again.
  const matching = candidates.length ? candidates : sameSource.filter(record =>
    intent.repositories.every(id =>
      record.intent.repositories.includes(id)) && record.consumers.every(consumer =>
      binding.consumers.some(adopted => adopted.repositoryId === consumer.repositoryId &&
        adopted.repository === consumer.repository)));
  const recoverable = [];
  for (const record of matching) {
    if (candidates.includes(record) || record.intent.activation) {
      recoverable.push(record);
      continue;
    }
    // The execution caller can finish first during same-source bootstrap.
    // Recover earlier selected proposals only from their current native identity.
    for (const consumer of record.consumers) {
      if (intent.repositories.includes(consumer.repositoryId) && consumer.proposal &&
        await ports.disposition(consumer, consumer.proposal) === 'current') {
        recoverable.push(record);
        break;
      }
    }
  }
  requireThat(recoverable.length <= 1, 'UPGRADE_OPERATION_AMBIGUOUS');
  return recoverable[0];
}

export async function prepareUpgrade(request, ports) {
  const value = upgradePreparation(request);
  const binding = await ports.adoption();
  const repositories = [...value.repositories].sort((a, b) => a - b);
  const consumers = repositories.map(repositoryId => {
    const consumer = binding.consumers.find(item => item.repositoryId === repositoryId);
    requireThat(consumer, 'UPGRADE_CONSUMER_NOT_ADOPTED');
    return consumer;
  });
  const intent = { repositories, source: value.source, activation: value.activation };
  await ports.sourceIntent(intent, binding);
  const records = await ports.read();
  const existing = await priorUpgrade(records, binding, intent, ports);
  if (existing) return reply(existing);
  const operation = { id: randomUUID(), memberId: binding.memberId,
    execution: binding.execution, intent, consumers, progress: initial(),
    readinessBefore: await ports.readinessIdentity(binding),
  };
  await ports.write([...records, operation]);
  return reply(operation);
}

async function selectedOperation(records, id, ports) {
  const operation = records.find(record => record.id === id);
  requireThat(operation, 'UPGRADE_OPERATION_UNAVAILABLE');
  const adoption = await ports.adoption();
  requireThat(operation.memberId === adoption.memberId &&
    sameIntent(operation.execution, adoption.execution) &&
    operation.consumers.every(consumer => adoption.consumers.some(adopted =>
      adopted.repositoryId === consumer.repositoryId &&
      adopted.repository === consumer.repository)), 'UPGRADE_ADOPTION_CHANGED');
  return { operation, adoption };
}

function diagnostics(error, fallback) {
  const cause = workflowDispatchFailure(error) ?? githubReadDiagnostic(error);
  return cause ?? { code: /^[A-Z][A-Z0-9_]*$/.test(error.code ?? '') ?
    error.code : fallback };
}

export async function bindUpgrade(request, ports) {
  const value = upgradeBinding(request);
  const records = await ports.read();
  const { operation, adoption } = await selectedOperation(
    records, value.operationId, ports);
  const consumer = operation.consumers.find(item =>
    item.repositoryId === value.repositoryId);
  requireThat(consumer, 'UPGRADE_CONSUMER_NOT_ADOPTED');
  await ports.sourceIntent({ ...operation.intent, repositories: [value.repositoryId] },
    adoption);
  const owner = records.find(record => record.consumers.some(item =>
    item.repositoryId === value.repositoryId && item.proposal?.pullNumber ===
      value.pullNumber));
  requireThat(!owner || owner === operation, 'UPGRADE_PROPOSAL_ALREADY_BOUND');
  const proposal = await ports.proposal(consumer, value.pullNumber, operation.memberId);
  if (consumer.proposal && !sameProposal(consumer.proposal, proposal)) {
    requireThat(consumer.proposal.pullNumber !== value.pullNumber &&
      await ports.disposition(consumer, consumer.proposal) === 'abandoned',
    'UPGRADE_PROPOSAL_CHANGED');
    delete consumer.adopted;
    operation.progress.installation = 'pending';
  }
  delete consumer.directVerified;
  consumer.proposal = { ...proposal, handoff: 'review-pending' };
  operation.progress.handoff = 'review-pending';
  // Save the native PR identity before verifying the route. The merge can reach
  // an already authorized continuation even when the caller's response is lost.
  await ports.write(records);
  try { await ports.route(operation, consumer); }
  catch (error) {
    return reply(operation, {
      handoffCause: diagnostics(error, 'UPGRADE_HANDOFF_ROUTE_UNVERIFIED'),
    });
  }
  consumer.proposal.handoff = 'confirmed';
  confirmHandoff(operation);
  await ports.write(records);
  return reply(operation);
}

export async function observeUpgrade(request, ports) {
  const value = upgradeObservation(request);
  const { operation } = await selectedOperation(await ports.read(),
    value.operationId, ports);
  for (const consumer of operation.consumers) {
    if (!consumer.proposal) continue;
    if (await ports.disposition(consumer, consumer.proposal) === 'abandoned') {
      delete consumer.proposal;
      operation.progress.handoff = 'pending';
      continue;
    }
    const current = await ports.proposal(consumer, consumer.proposal.pullNumber,
      operation.memberId);
    requireThat(sameProposal(consumer.proposal, current), 'UPGRADE_PROPOSAL_CHANGED');
    await ports.route(operation, consumer);
    consumer.proposal = { ...consumer.proposal, ...current, handoff: 'confirmed' };
  }
  confirmHandoff(operation);
  return reply(operation);
}

export async function matchedUpgrade(target, ports) {
  const records = await ports.read();
  const matched = records.filter(record => record.consumers.some(consumer =>
    consumer.repositoryId === target.repositoryId &&
    consumer.proposal?.pullNumber === target.pullNumber));
  requireThat(matched.length === 1, 'UPGRADE_PROPOSAL_NOT_BOUND');
  const { operation, adoption } = await selectedOperation(records, matched[0].id,
    ports);
  const consumer = operation.consumers.find(item =>
    item.repositoryId === target.repositoryId);
  const proposal = await ports.proposal(consumer, target.pullNumber, operation.memberId);
  requireThat(sameProposal(consumer.proposal, proposal) && proposal.merged,
    'UPGRADE_PROPOSAL_NOT_MERGED');
  return { records, operation, adoption, consumer, proposal };
}

export async function completeUpgrade(binding, ports) {
  const { records, operation, adoption, consumer, proposal, observed } = binding;
  const progress = operation.progress;
  if (consumer && proposal) {
    consumer.proposal = { ...consumer.proposal, ...proposal, handoff: 'confirmed' };
  }
  if (consumer && observed) {
    consumer.proposal.executionRun = { runId: observed.runId,
      url: `https://github.com/${operation.execution.repository}/actions/runs/` +
        observed.runId };
  }
  confirmHandoff(operation);
  const promote = !sameUpgradeSource(adoption.host.installation.pin,
    operation.intent.source);
  if (promote && progress.installation === 'maintenance-required')
    return reply(operation);
  if (promote)
    operation.promotionPending = true;
  await ports.write(records);
  let installed;
  try { installed = await ports.install(operation, adoption, consumer); }
  catch (error) {
    progress.installationCause = diagnostics(error, 'UPGRADE_INSTALLATION_PENDING');
    if (consumer) consumer.installationCause = progress.installationCause;
    await ports.write(records);
    return reply(operation);
  }
  if (installed.status !== 'installed') {
    progress.installation = installed.status;
    if (installed.coreRunId) operation.coreRunId = installed.coreRunId;
    progress.installationCause = { code: installed.code };
    if (consumer) consumer.installationCause = progress.installationCause;
    await ports.write(records);
    return reply(operation);
  }
  for (const item of consumer ? [consumer] : operation.consumers) {
    item.adopted = true;
    delete item.installationCause;
  }
  if (operation.consumers.every(item => item.adopted))
    progress.installation = 'installed';
  delete progress.installationCause;
  await ports.write(records);
  try {
    const current = await ports.readinessIdentity(adoption);
    if (!current.configured || sameIntent(operation.readinessBefore, current)) {
      progress.readiness = 'not-required';
    } else {
      if (!sameIntent(operation.readinessVerified, current)) {
        await ports.readiness(current);
        operation.readinessVerified = current;
      }
      progress.readiness = 'ready';
    }
    delete progress.readinessCause;
  } catch (error) {
    const unsupported = ['JOB_VM_GUEST_INIT_UNAVAILABLE',
      'JOB_VM_GUEST_PYTHON_UNAVAILABLE', 'JOB_VM_TOOL_OUTPUT_UNAVAILABLE',
      'JOB_VM_READINESS_EFFECT_UNAVAILABLE'];
    progress.readiness = unsupported.includes(error.code) ?
      'maintenance-required' : 'pending';
    progress.readinessCause = diagnostics(error, 'UPGRADE_READINESS_PENDING');
  }
  try { progress.cleanup = await ports.cleanup(); }
  catch (error) {
    progress.cleanup = { status: 'pending',
      ...diagnostics(error, 'UPGRADE_CLEANUP_PENDING') };
  }
  await ports.write(records);
  return reply(operation, { continuationEligible:
    ['ready', 'not-required'].includes(progress.readiness) });
}

export async function recordUnsupportedUpgradeActivation(activation, ports) {
  const records = await ports.read();
  for (const operation of records) {
    if (!operation.promotionPending || !sameIntent(operation.intent.activation,
      activation)) continue;
    operation.progress.installation = 'maintenance-required';
    operation.progress.installationCause = { code: 'CORE_ONLY_MAINTENANCE_REQUIRED' };
  }
  await ports.write(records);
  return { status: 'complete' };
}

export async function completeUpgradeWithoutProposal(request, ports) {
  const value = upgradeCompletion(request);
  return completeDirectUpgrades(value.operationId, ports,
    { repositories: value.repositories, authorize: true });
}

export async function completeDirectUpgrades(operationId, ports, {
  allowNoEligible = false, repositories, authorize = false,
} = {}) {
  const records = await ports.read();
  const { operation, adoption } = await selectedOperation(
    records, operationId, ports);
  if (authorize) {
    const selected = repositories ?? operation.intent.repositories;
    requireThat(selected.every(id => operation.intent.repositories.includes(id)),
      'UPGRADE_CONSUMER_NOT_ADOPTED');
    await ports.sourceIntent({ ...operation.intent, repositories: selected }, adoption);
  }
  let considered = false, observedError, changed = false, eligible = false;
  for (const consumer of operation.consumers) {
    if (repositories && !repositories.includes(consumer.repositoryId)) continue;
    try {
      if (consumer.proposal &&
        await ports.disposition(consumer, consumer.proposal) !== 'abandoned') continue;
      considered = true;
      // No local PR binding is only a locator fact. Native current caller
      // source and routing establish eligibility for proposal-free completion.
      await ports.noProposal(operation, consumer);
    } catch (error) {
      observedError ??= error;
      consumer.installationCause = diagnostics(error, 'UPGRADE_NO_CHANGE_UNVERIFIED');
      changed = true;
      continue;
    }
    delete consumer.proposal;
    consumer.directVerified = true;
    const completed = await completeUpgrade({ records, operation, adoption, consumer },
      ports);
    eligible ||= completed.upgrade.continuationEligible === true;
  }
  if (changed) await ports.write(records);
  if (!considered && !allowNoEligible) {
    if (observedError) throw observedError;
    requireThat(false, 'UPGRADE_PROPOSAL_REQUIRES_NATIVE_COMPLETION');
  }
  if (!considered && !changed) return null;
  return reply(operation, { continuationEligible: eligible &&
    ['ready', 'not-required'].includes(operation.progress.readiness) });
}

export async function settleUpgradeContinuation(operationId, result, ports) {
  const records = await ports.read();
  const { operation } = await selectedOperation(records, operationId, ports);
  requireThat(['pending', 'paused', 'dispatched'].includes(result.status),
    'UPGRADE_CONTINUATION_RESULT_INVALID');
  operation.progress.continuation = result.status;
  if (result.status === 'pending') {
    operation.progress.continuationCause = diagnostics(result,
      'UPGRADE_CONTINUATION_PENDING');
  } else delete operation.progress.continuationCause;
  await ports.write(records);
  return reply(operation, { continuationResults: result.results ?? [] });
}
