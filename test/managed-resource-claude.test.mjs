import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { digest } from '../src/identity.mjs';
import { deliverManagedResources } from '../src/managed-resource-prepare.mjs';
import { verifyPreparationResult } from '../src/managed-resource-smoke.mjs';
import {
  managedResources as resources, managedPreparationCapability,
} from '../src/managed-resource-contract.mjs';
import {
  prepareManagedSharedHost, preparationAgent,
} from '../src/managed-resource-install.mjs';
import { fixture, image } from './managed-resource-fixture.mjs';

// One line per IO call; probe names and the random owner are normalized.
function traced(io) {
  const calls = [];
  const summary = {
    image: (kind, state, inputs, observe) => [kind, observe],
    policy: (bytes, observe, target) => [bytes, observe, target?.name],
    availability: (id, kind) => [kind],
    docker: (managed, args) => args[0] === 'create'
      ? ['create', args.at(-2), args.find(arg => arg.includes('apparmor='))]
      : [args[0]],
    save: state => [Object.keys(state).join(), Object.keys(state.effects).join()],
  };
  for (const [name, value] of Object.entries(io)) {
    if (typeof value !== 'function') continue;
    io[name] = (...args) => {
      calls.push([name, ...(summary[name]?.(...args) ?? [])].join(' '));
      return value(...args);
    };
  }
  return calls;
}

const normalized = state => JSON.parse(JSON.stringify(state)
  .replaceAll(state.owner, 'owner')
  .replaceAll(state.probe.name, 'probe'));

const goldenFile = new URL('./fixtures/managed-resource-codex-golden.json',
  import.meta.url);
// Captured from the Codex-only orchestration before the Claude request existed.
const golden = async () => JSON.parse(await readFile(goldenFile, 'utf8'));

// A fresh run and its repeat on the prepared journal.
async function codexRuns(io, options) {
  const calls = traced(io);
  const runs = [];
  for (let run = 0; run < 2; run++) {
    const result = await deliverManagedResources(io, options);
    runs.push({ calls: calls.splice(0), journal: normalized(io.state), result });
  }
  return runs;
}

test('a run without the Claude request keeps the Codex journal, calls and result',
  async () => {
    const runs = await codexRuns(fixture());
    assert.deepEqual(runs, await golden());
    verifyPreparationResult(runs[1].result);
  });

const claudeKind = resources.claude.kind;
const claudeProfile = resources.claude.apparmor;
const claudeImage = image(claudeKind);
const claudeOptions = { claude: true };
const withoutClaude = ({ claude, ...journal }) => journal;
const withoutProbe = ({ probe, ...journal }) => journal;

test('a fresh Claude request prepares Codex first, then its own section', async () => {
  const io = fixture();
  const calls = traced(io);
  const result = await deliverManagedResources(io, claudeOptions);
  const [codex] = await golden();
  assert.deepEqual(result, codex.result);
  const journal = normalized(io.state);
  assert.deepEqual(withoutProbe(withoutClaude(journal)), withoutProbe(codex.journal));
  assert.deepEqual(journal.claude, {
    inputs: digest({ recipe: 'claude recipe', package: 'script', shell: 'shell',
      profile: 'claude policy', version: '2.1.326' }),
    effects: { [`image:${claudeKind}`]: 'complete', 'policy:claude': 'complete' },
    images: { [claudeKind]: claudeImage } });
  assert.equal(journal.probe.key, `2:${claudeKind}`);
  const first = name => calls.indexOf(name);
  const last = name => calls.lastIndexOf(name);
  assert(first('pristine') < first('claudePristine'));
  assert(first('claudePristine') < first('gate'));
  const create = `docker create ${claudeImage} --security-opt=apparmor=${claudeProfile}`;
  assert.equal(calls.filter(call => call === create).length, 2);
  assert.equal(calls.filter(call => call === `availability ${claudeKind}`).length, 2);
  assert(last('availability hooks') < first(`image ${claudeKind} false`));
  assert(first(`image ${claudeKind} false`) <
    first(`policy claude policy false ${claudeProfile}`));
  assert(first(`policy claude policy false ${claudeProfile}`) < first(create));
  assert(last('egress') < first(`image ${claudeKind} true`));
  assert(first(`image ${claudeKind} true`) <
    first(`policy claude policy true ${claudeProfile}`));
  assert(first(`policy claude policy true ${claudeProfile}`) < last('verifyEngine'));
  assert(last('verifyEngine') < first('publish'));
  assert.equal(io.proofs, 6);
});

test('an existing prepared Codex journal only gains the Claude section', async () => {
  const io = fixture();
  const codex = await deliverManagedResources(io);
  const before = structuredClone(io.state);
  assert.deepEqual(await deliverManagedResources(io, claudeOptions), codex);
  assert.deepEqual(withoutProbe(withoutClaude(io.state)), withoutProbe(before));
  assert.deepEqual(Object.keys(io.state.claude.effects),
    [`image:${claudeKind}`, 'policy:claude']);
  // A later run without the request leaves the Claude section untouched.
  const claude = structuredClone(io.state.claude);
  const calls = traced(io);
  assert.deepEqual(await deliverManagedResources(io), codex);
  assert.deepEqual(io.state.claude, claude);
  assert(!calls.some(call => call.includes(claudeKind) || call === 'claudePristine'));
});

test('an interrupted Claude effect resumes only by observation', async () => {
  const interrupts = {
    image: (kind, state, inputs, observe) => kind === claudeKind && !observe,
    policy: (bytes, observe, target) => target?.name === claudeProfile && !observe,
  };
  for (const [method, key, call] of [
    ['image', `image:${claudeKind}`, `image ${claudeKind}`],
    ['policy', 'policy:claude', 'policy claude policy']]) {
    const io = fixture();
    const original = io[method];
    let interrupted = false;
    io[method] = async (...args) => {
      const value = await original(...args);
      if (interrupts[method](...args) && !interrupted) {
        interrupted = true;
        throw { code: 'RESOURCE_INTERRUPTED' };
      }
      return value;
    };
    await assert.rejects(deliverManagedResources(io, claudeOptions),
      { code: 'RESOURCE_INTERRUPTED' });
    assert.equal(io.state.claude.effects[key], 'pending');
    assert.equal(io.state.effects.profile, undefined);
    const calls = traced(io);
    await deliverManagedResources(io, claudeOptions);
    assert.equal(io.state.claude.effects[key], 'complete');
    const suffix = method === 'policy' ? ` ${claudeProfile}` : '';
    assert(!calls.includes(`${call} false${suffix}`), method);
    assert.equal(calls.filter(entry => entry === `${call} true${suffix}`).length, 2,
      method);
  }
});

test('changed Claude inputs conflict before the gate or any Claude effect',
  async () => {
    const io = fixture();
    await deliverManagedResources(io, claudeOptions);
    const before = structuredClone(io.state);
    const inputs = io.inputs;
    io.inputs = async (architecture, options) => {
      const value = await inputs(architecture, options);
      if (options?.claude) value[resources.claude.package] = 'moved script';
      return value;
    };
    const calls = traced(io);
    await assert.rejects(deliverManagedResources(io, claudeOptions),
      { code: 'RESOURCE_STATE_CONFLICT' });
    assert.deepEqual(io.state, before);
    assert(!calls.includes('gate') && !calls.includes('claudePristine'));
    // Claude-inclusive inputs without the Claude pin are not a Claude request.
    io.inputs = async (architecture, options) => ({
      ...await inputs(architecture, options), ...options?.claude && { versions: {} } });
    await assert.rejects(deliverManagedResources(io, claudeOptions),
      { code: 'RESOURCE_INPUT_CONTRACT_INVALID' });
    // The Codex flow alone is unaffected by the Claude inputs.
    io.inputs = inputs;
    await deliverManagedResources(io);
  });

test('foreign Claude resources refuse the request before its section exists',
  async () => {
    const io = fixture();
    io.claudePristine = async () => { throw { code: 'RESOURCE_FOREIGN_POLICY' }; };
    await assert.rejects(deliverManagedResources(io, claudeOptions),
      { code: 'RESOURCE_FOREIGN_POLICY' });
    assert.equal(io.state.claude, undefined);
    assert.equal(io.gateOwner, null);
    assert.deepEqual(io.state.effects, {});
  });

test('a Claude probe under the Codex profile is refused', async () => {
  const io = fixture();
  const kernelProof = io.kernelProof;
  io.kernelProof = async pid => {
    const proof = await kernelProof(pid);
    return io.proofs > 4 ? { ...proof, label: 'codex-security-container (enforce)' }
      : proof;
  };
  await assert.rejects(deliverManagedResources(io, claudeOptions),
    { code: 'RESOURCE_APPARMOR_NOT_ENFORCED' });
  assert.equal(io.state.probe.key, `1:${claudeKind}`);
  assert.equal(io.state.probe.phase, 'complete');
  assert.equal(io.state.effects.profile, undefined);
});

test('the entry accepts only the Claude agent after consent', async () => {
  const entry = args => {
    const result = spawnSync(process.execPath,
      ['bin/nibfin-prepare-shared-host.mjs', ...args], { encoding: 'utf8' });
    return [result.status, JSON.parse(result.stdout).code];
  };
  const consent = '--consent-resource-preparation';
  for (const value of ['codex', '', 'Claude', 'claude,codex'])
    assert.deepEqual(entry([consent, `--agent=${value}`]),
      [1, 'RESOURCE_PREPARATION_AGENT_UNSUPPORTED'], value);
  for (const args of [['--agent=claude'], ['--agent=claude', consent],
    [consent, '--agent=claude', '--agent=claude'], [consent, '--agent']])
    assert.deepEqual(entry(args), [1, 'RESOURCE_PREPARATION_CONSENT_REQUIRED']);
  // A Claude request reaches the same engine admission as the Codex run.
  assert.deepEqual(entry([consent, '--agent=claude']), entry([consent]));
  await assert.rejects(prepareManagedSharedHost(true, { agent: 'codex' }),
    { code: 'RESOURCE_PREPARATION_AGENT_UNSUPPORTED' });
  assert.equal(preparationAgent(undefined), undefined);
  assert.equal(preparationAgent('claude'), 'claude');
  assert.deepEqual(managedPreparationCapability.arguments, [consent]);
});
