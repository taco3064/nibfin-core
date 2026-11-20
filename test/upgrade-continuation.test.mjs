import test from 'node:test';
import assert from 'node:assert/strict';
import { consumerContract } from '../src/public-api.mjs';
import { upgradeRecipe } from '../src/upgrade-continuation-contract.mjs';
import { adoptMatchingUpgrades } from '../src/upgrade-continuation-manager.mjs';
import { prepareUpgrade, bindUpgrade, observeUpgrade, matchedUpgrade, completeUpgrade,
  completeUpgradeWithoutProposal, settleUpgradeContinuation,
  recordUnsupportedUpgradeActivation, mergeUpgradeOperations }
  from '../src/upgrade-continuation-operations.mjs';

const pin = { repository: 'taco3064/nibfin-core', commit: 'a'.repeat(40),
  manifestHash: 'b'.repeat(64) };
const next = { ...pin, commit: 'c'.repeat(40), manifestHash: 'd'.repeat(64) };
const consumer = { repository: 'member/consumer', repositoryId: 1 };
const peer = { repository: 'member/peer', repositoryId: 3 };
const execution = { repository: 'member/execution', repositoryId: 2 };
const requested = (source = pin, activation = null) =>
  ({ kind: 'upgrade-prepare', repositories: [1], source, activation });
const target = { repositoryId: 1, pullNumber: 10 };
const requestToBind = operationId => ({ kind: 'upgrade-bind', operationId, ...target });
const selector = operationId => ({ kind: 'upgrade-observe', operationId });
const fixture = () => {
  let saved = [];
  const state = { source: pin, ready: { configured: true, files: ['old'] },
    merged: false, route: true, pullId: 80, boots: 0, installments: 0,
    disposition: 'current' };
  const ports = {
    read: async () => structuredClone(saved),
    write: async records => { saved = structuredClone(records); },
    adoption: async () => ({ consumers: [consumer, peer], memberId: 5, execution,
      host: { installation: { pin: state.source } } }),
    sourceIntent: async () => {},
    readinessIdentity: async () => structuredClone(state.ready),
    readiness: async () => { state.boots++; },
    proposal: async (_consumer, pullNumber) => ({ ...consumer, pullNumber,
      pullId: state.pullId, pullNodeId: 'PR_' + state.pullId, merged: state.merged }),
    disposition: async () => state.disposition,
    noProposal: async () => {},
    route: async () => {
      if (!state.route) throw Object.assign(new Error('provider unavailable'),
        { code: 'PROVIDER_UNAVAILABLE' });
    },
    install: async () => {
      state.installments++;
      return { status: 'installed' };
    },
    cleanup: async () => ({ status: 'pending', code: 'OTHER_CONSUMER_UNFINISHED' }),
  };
  return { ports, state };
};

test('verified Core discovery exposes separate composable recipes and stdin kinds',
  () => {
    const contract = consumerContract.managedUpgradeContinuation;
    assert.equal(contract.administrator.input, 'private-json-stdin');
    const notification = upgradeRecipe('notification');
    const worker = upgradeRecipe('execution', 42);
    assert.match(notification, /pull_request:\n    types: \[closed\]/);
    assert.match(notification, /workflow_dispatch:/);
    assert.match(notification, /github\.event\.pull_request\.merged/);
    assert.match(notification, /github\.event\.pull_request\.head\.repo\.id/);
    assert.match(worker, /nibfin-user-42/);
    assert.match(worker, /\bid-token: write\b/);
    assert.doesNotMatch(worker, /actions\/checkout|GITHUB_EVENT_PATH/);
    assert.throws(() => upgradeRecipe('execution', 'malicious'));
  });

test('adopted authority and remembered native PR identity survive a missing response',
  async () => {
    const { ports, state } = fixture();
    const update = await prepareUpgrade(requested(), ports);
    const original = update.upgrade.operationId;
    const repeated = await prepareUpgrade(requested(), ports);
    assert.equal(repeated.upgrade.operationId, original);
    state.route = false;
    await assert.rejects(bindUpgrade(requestToBind(original), ports),
      { code: 'PROVIDER_UNAVAILABLE' });
    const remembered = await ports.read();
    assert.equal(remembered[0].consumers[0].proposal.pullId, 80);
    state.route = true;
    assert.equal((await observeUpgrade(selector(original), ports)).upgrade.handoff,
      'confirmed');
    state.pullId++;
    await assert.rejects(bindUpgrade(requestToBind(original), ports),
      { code: 'UPGRADE_PROPOSAL_CHANGED' });
  });

test('a replacement proposal requires fresh confirmation of old PR abandonment',
  async () => {
    const { ports, state } = fixture();
    const original = (await prepareUpgrade(requested(), ports)).upgrade.operationId;
    await bindUpgrade(requestToBind(original), ports);
    state.pullId = 81;
    const replacement = { ...requestToBind(original), pullNumber: 11 };
    await assert.rejects(bindUpgrade(replacement, ports),
      { code: 'UPGRADE_PROPOSAL_CHANGED' });
    const offline = Object.assign(new Error('unknown'), { code: 'READ_PENDING' });
    ports.disposition = async () => { throw offline; };
    await assert.rejects(bindUpgrade(replacement, ports), { code: 'READ_PENDING' });
    ports.disposition = async () => 'abandoned';
    const visible = (await observeUpgrade(selector(original), ports)).upgrade;
    assert.deepEqual(visible.proposals, []);
    assert.equal(visible.handoff, 'pending');
    const changed = (await bindUpgrade(replacement, ports)).upgrade;
    assert.equal(changed.proposals[0].pullNumber, 11);
    await assert.rejects(matchedUpgrade(target, ports),
      { code: 'UPGRADE_PROPOSAL_NOT_BOUND' });
  });

test('unbound, unmerged and caller-chosen targets cannot enter completion', async () => {
  const { ports } = fixture();
  const original = (await prepareUpgrade(requested(), ports)).upgrade.operationId;
  await assert.rejects(matchedUpgrade(target, ports),
    { code: 'UPGRADE_PROPOSAL_NOT_BOUND' });
  await bindUpgrade(requestToBind(original), ports);
  await assert.rejects(matchedUpgrade(target, ports),
    { code: 'UPGRADE_PROPOSAL_NOT_MERGED' });
  await assert.rejects(completeUpgradeWithoutProposal(selector(original), ports),
    { code: 'UPGRADE_PROPOSAL_REQUIRES_NATIVE_COMPLETION' });
  await assert.rejects(prepareUpgrade({ ...requested(), command: '/tmp/tool' }, ports),
    { code: 'UPGRADE_REQUEST_INVALID' });
  await assert.rejects(prepareUpgrade({ ...requested(), repositories: [999] }, ports),
    { code: 'UPGRADE_CONSUMER_NOT_ADOPTED' });
});

test('initial proposal-free apply and unrelated source change need no model-free boot',
  async () => {
    const { ports, state } = fixture();
    const original = (await prepareUpgrade(requested(), ports)).upgrade.operationId;
    const installed = (await completeUpgradeWithoutProposal(
      { kind: 'upgrade-complete', operationId: original }, ports)).upgrade;
    assert.equal(installed.installation, 'installed');
    assert.equal(installed.readiness, 'not-required');
    assert.equal(installed.continuation, 'pending');
    assert.deepEqual(installed.cleanup,
      { status: 'pending', code: 'OTHER_CONSUMER_UNFINISHED' });
    assert.equal(state.boots, 0);
    assert.equal(installed.proposals.length, 0);
  });

test('ready no-change consumer independently settles while another PR is reviewed',
  async () => {
    const { ports, state } = fixture();
    const request = { ...requested(), repositories: [1, 3] };
    const prepared = await prepareUpgrade(request, ports);
    const operationId = prepared.upgrade.operationId;
    await bindUpgrade(requestToBind(operationId), ports);
    const verified = [], installed = [];
    ports.noProposal = async (_operation, candidate) =>
      verified.push(candidate.repositoryId);
    ports.install = async (_operation, _adoption, candidate) => {
      installed.push(candidate.repositoryId);
      return { status: 'installed' };
    };
    const pendingProposal = await completeUpgradeWithoutProposal(
      { kind: 'upgrade-complete', operationId }, ports);
    assert.equal(pendingProposal.upgrade.operationId, operationId);
    assert.equal(pendingProposal.upgrade.installation, 'pending');
    assert.equal(pendingProposal.upgrade.continuationEligible, true);
    assert.deepEqual(pendingProposal.upgrade.consumers.map(item => item.installation),
      ['pending', 'installed']);
    assert.deepEqual(verified, [3]);
    assert.deepEqual(installed, [3]);

    state.merged = true;
    const merged = await completeUpgrade(await matchedUpgrade(target, ports), ports);
    assert.equal(merged.upgrade.operationId, operationId);
    assert.equal(merged.upgrade.installation, 'installed');
    assert.deepEqual(merged.upgrade.consumers.map(item => item.installation),
      ['installed', 'installed']);
    assert.deepEqual(installed, [3, 1]);
  });

test('confirmed abandoned proposal is dropped after positive no-change observation',
  async () => {
    const { ports, state } = fixture();
    const operationId = (await prepareUpgrade(requested(), ports)).upgrade.operationId;
    const request = { kind: 'upgrade-complete', operationId };
    await bindUpgrade(requestToBind(operationId), ports);
    state.disposition = 'abandoned';
    ports.noProposal = async () => {
      throw Object.assign(new Error('source unknown'), { code: 'SOURCE_PENDING' });
    };
    const pending = (await completeUpgradeWithoutProposal(request, ports)).upgrade;
    assert.equal(pending.consumers[0].cause.code, 'SOURCE_PENDING');
    assert.equal(pending.installation, 'pending');
    assert.equal(state.installments, 0);
    assert.equal((await ports.read())[0].consumers[0].proposal.pullNumber, 10);
    ports.noProposal = async () => {};
    const direct = (await completeUpgradeWithoutProposal(request, ports)).upgrade;
    assert.equal(direct.operationId, operationId);
    assert.equal(direct.installation, 'installed');
    assert.deepEqual(direct.proposals, []);
    assert.equal(state.installments, 1);
    await assert.rejects(matchedUpgrade(target, ports),
      { code: 'UPGRADE_PROPOSAL_NOT_BOUND' });
  });

test('initial caller records a PR before the real native route becomes available',
  async () => {
    const { ports, state } = fixture();
    const operationId = (await prepareUpgrade(requested(), ports)).upgrade.operationId;
    state.route = false;
    await assert.rejects(bindUpgrade(requestToBind(operationId), ports),
      { code: 'PROVIDER_UNAVAILABLE' });
    state.route = true;
    state.merged = true;
    const binding = await matchedUpgrade(target, ports);
    const completed = await completeUpgrade({ ...binding, observed: { runId: 96 } },
      ports);
    assert.equal(completed.upgrade.handoff, 'confirmed');
    assert.equal(completed.upgrade.installation, 'installed');
    const current = (await observeUpgrade(selector(operationId), ports)).upgrade;
    assert.deepEqual(current.proposals[0].executionRun, {
      runId: 96, url: 'https://github.com/member/execution/actions/runs/96',
    });
  });

test('confirmed installed source stays installed until readiness and continuation settle',
  async () => {
    const { ports, state } = fixture();
    const original = (await prepareUpgrade(requested(next,
      { runId: 90, artifactId: 91 }), ports)).upgrade.operationId;
    await bindUpgrade(requestToBind(original), ports);
    state.merged = true;
    state.source = next;
    state.ready = { configured: true, files: ['changed executor'] };
    ports.readiness = async () => { throw new Error('guest initialization failed'); };
    const pending = (await completeUpgrade(await matchedUpgrade(target, ports),
      ports)).upgrade;
    assert.equal(pending.readiness, 'pending');
    assert.equal(pending.readinessCause.code, 'UPGRADE_READINESS_PENDING');
    assert.equal((await observeUpgrade(selector(original), ports)).upgrade.installation,
      'installed');
    ports.readiness = async () => { state.boots++; };
    const completed = await completeUpgrade(await matchedUpgrade(target, ports), ports);
    assert.equal(completed.upgrade.readiness, 'ready');
    assert.equal(completed.upgrade.continuation, 'pending');
    assert.equal(state.boots, 1);
    await completeUpgrade(await matchedUpgrade(target, ports), ports);
    assert.equal(state.boots, 1);
    const paused = await settleUpgradeContinuation(original,
      { status: 'paused', results: [] }, ports);
    assert.equal(paused.upgrade.readiness, 'ready');
    assert.equal(paused.upgrade.continuation, 'paused');
  });

test('shared promotion report uses existing Core job and preserves maintenance cause',
  async () => {
    const { ports, state } = fixture();
    const activation = { runId: 77, artifactId: 78 };
    const operationId = (await prepareUpgrade(requested(next, activation), ports))
      .upgrade.operationId;
    ports.install = async () => {
      state.installments++;
      return { status: 'pending', code: 'UPGRADE_CORE_ACTIVATION_QUEUED', coreRunId: 83 };
    };
    const request = { kind: 'upgrade-complete', operationId };
    const queued = (await completeUpgradeWithoutProposal(request, ports)).upgrade;
    assert.equal(queued.coreRunId, 83);
    assert.equal(queued.installation, 'pending');
    assert.equal(queued.readiness, 'pending');
    await recordUnsupportedUpgradeActivation(activation, ports);
    const refused = (await completeUpgradeWithoutProposal(request, ports)).upgrade;
    assert.equal(refused.installation, 'maintenance-required');
    assert.equal(refused.installationCause.code, 'CORE_ONLY_MAINTENANCE_REQUIRED');
    assert.equal(state.installments, 1);
  });

test('short record write retains distinct concurrent operation progress', () => {
  const alpha = { id: 'alpha', state: 'initial' };
  const beta = { id: 'beta', state: 'observed' };
  const changed = { ...alpha, state: 'ready' };
  assert.deepEqual(mergeUpgradeOperations([alpha, beta], [alpha], [changed]),
    [changed, beta]);
  assert.throws(() => mergeUpgradeOperations([changed], [alpha],
    [{ ...alpha, state: 'elsewhere' }]), { code: 'UPGRADE_OPERATION_CHANGED' });
});

test('post-install processes only the authorized native activation', async () => {
  const { ports, state } = fixture();
  const activation = { runId: 21, artifactId: 22 };
  const operationId = (await prepareUpgrade(requested(next, activation), ports))
    .upgrade.operationId;
  ports.install = async () => ({ status: 'pending' });
  await completeUpgradeWithoutProposal({ kind: 'upgrade-complete', operationId }, ports);
  const readAdoption = ports.adoption;
  ports.adoption = () => assert.fail('Unrelated Core CD must not enter this upgrade');
  const unrelated = await adoptMatchingUpgrades(ports, { ...activation, artifactId: 23 });
  assert.deepEqual(unrelated.upgradeOperations, []);
  ports.adoption = readAdoption;
  state.source = next;
  ports.install = async () => ({ status: 'installed' });
  const matched = await adoptMatchingUpgrades(ports, activation);
  assert.equal(matched.upgradeOperations[0].operationId, operationId);
  assert.equal(matched.upgradeOperations[0].continuationEligible, true);
});
