import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { digest } from '../src/identity.mjs';
import { managedResourceHost, policyTargets } from '../src/managed-resource-host.mjs';
import { managedResources as resources } from '../src/managed-resource-contract.mjs';
import { claudeAppArmorProfile } from '../src/claude-agent-plan.mjs';
import { resourcePreparationGate } from '../src/managed-resource-admission.mjs';
import { confinement, probeModule } from '../scripts/verify-live-claude-agent-image.mjs';
import { fileDouble } from './file-store-fixture.mjs';

const security = new URL('../src/security/', import.meta.url);
const source = name => readFile(new URL(name, security), 'utf8');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const codexName = 'codex-security-container';
// Upstream bytes at the README's openai/codex-security commit.
const codexProfileSha256 =
  '87f6b85e4eff2dafe25ec605d5d27f2958935534f892f32531ba93ab94dca3cf';
const header = [
  '# Derived from codex-security.apparmor, copied from openai/codex-security commit',
  '# 3fa6215fc1021bbee546a61f8b407bcd521953f0 (Apache-2.0; see LICENSE). The only',
  '# differences: the profile and its self peers are named nibfin-claude-container,',
  '# and every process environ read is denied.', '', ''].join('\n');
const kcore = '  deny @{PROC}/kcore rwklx,\n';
const environ = '  deny @{PROC}/*/environ r,\n  deny @{PROC}/*/task/*/environ r,\n';

test('the Claude profile is the Codex profile with only the stated edits', async () => {
  const codex = await source('codex-security.apparmor');
  assert.equal(sha256(codex), codexProfileSha256);
  // The profile name and its two self peers, nothing else.
  assert.equal(codex.split(codexName).length - 1, 3);
  for (const line of [`profile ${codexName} flags=`,
    `signal (send,receive) peer=${codexName},`,
    `deny ptrace (trace,tracedby,read,readby) peer=${codexName},`])
    assert(codex.includes(line), line);
  assert.equal(codex.split(kcore).length - 1, 1);
  assert(!codex.includes('environ'));
  const expected = header + codex.replaceAll(codexName, claudeAppArmorProfile)
    .replace(kcore, kcore + environ);
  assert.equal(await source(resources.claude.profileFile), expected);
  const readme = await source('README.md');
  assert.match(readme, /^The Codex profiles are copied without modification/);
  assert(readme.includes('`nibfin-claude.apparmor` is derived from'));
});

test('the Claude policy target is separate and the Codex target is unchanged', () => {
  assert.deepEqual(policyTargets.codex, { path: '/etc/apparmor.d/nibfin-managed-codex',
    name: codexName, proof: 'policy.json' });
  assert.deepEqual(policyTargets.claude, {
    path: '/etc/apparmor.d/nibfin-managed-claude', name: 'nibfin-claude-container',
    proof: 'policy-claude.json' });
  assert.equal(resources.policy, policyTargets.codex.path);
  assert.equal(resources.apparmor, codexName);
  assert.equal(resources.claude.apparmor, claudeAppArmorProfile);
  assert.equal(resources.claude.profileFile, 'nibfin-claude.apparmor');
});

const profiles = '/sys/kernel/security/apparmor/policy/profiles';

// A root-owned filesystem, kernel profile listing and engine for the host IO.
function hostWorld() {
  const { nodes, store } = fileDouble();
  const directory = mode => ({ kind: 'directory', mode, uid: 0, gid: 0, nlink: 1 });
  for (const path of ['/var/lib', '/etc/apparmor.d', '/etc/nibfin'])
    nodes.set(path, directory(0o755));
  nodes.set(resources.state, directory(0o700));
  const kernel = new Map();
  const runs = [];
  const loadProfile = name => kernel.set(`p${kernel.size}`, { name,
    sha1: String(kernel.size).repeat(40), mode: 'enforce' });
  const kernelProfiles = {
    async readdir(path) { assert.equal(path, profiles); return [...kernel.keys()]; },
    async readFile(path) {
      for (const [entry, value] of kernel)
        for (const field of ['name', 'sha1', 'mode'])
          if (path === join(profiles, entry, field)) return `${value[field]}\n`;
      throw Object.assign(Error('ENOENT'), { code: 'ENOENT' });
    },
  };
  const engine = {
    async docker() { return ''; },
    async run(file, args) {
      runs.push([file, ...args]);
      assert.equal(file, '/usr/sbin/apparmor_parser');
      assert.equal(args[0], '--add');
      loadProfile(/^profile (\S+) /m.exec(nodes.get(args[1]).bytes)[1]);
    },
  };
  const io = managedResourceHost(async () => {}, engine,
    { files: store, kernelProfiles });
  return { io, nodes, kernel, runs, loadProfile };
}

test('Codex and Claude policies install, load and prove under their own names',
  async () => {
    const world = hostWorld();
    const codex = await source('codex-security.apparmor');
    const claude = await source(resources.claude.profileFile);
    await world.io.policy(codex, false);
    assert.deepEqual(world.runs, [['/usr/sbin/apparmor_parser', '--add',
      '/etc/apparmor.d/nibfin-managed-codex']]);
    const proof = name => JSON.parse(world.nodes
      .get(`${resources.state}/${name}`).bytes);
    assert.deepEqual(proof('policy.json'),
      { input: digest(codex), kernel: '0'.repeat(40) });
    // A loaded Codex profile does not make the Claude profile foreign.
    await world.io.policy(claude, false, policyTargets.claude);
    assert.deepEqual(world.runs.at(-1), ['/usr/sbin/apparmor_parser', '--add',
      '/etc/apparmor.d/nibfin-managed-claude']);
    assert.equal(world.nodes.get(policyTargets.claude.path).bytes, claude);
    assert.deepEqual(proof('policy-claude.json'),
      { input: digest(claude), kernel: '1'.repeat(40) });
    assert.deepEqual(proof('policy.json'),
      { input: digest(codex), kernel: '0'.repeat(40) });
    // Observation reuses each proof against its own kernel profile.
    await world.io.policy(codex, true);
    await world.io.policy(claude, true, policyTargets.claude);
    assert.equal(world.runs.length, 2);
    await assert.rejects(world.io.policy(codex, true, policyTargets.claude),
      { code: 'RESOURCE_POLICY_RECONCILIATION_REQUIRED' });
    // A second loaded Claude profile leaves its identity unproven.
    world.loadProfile(claudeAppArmorProfile);
    await assert.rejects(world.io.policy(claude, true, policyTargets.claude),
      { code: 'RESOURCE_POLICY_IDENTITY_UNPROVEN' });
    await world.io.policy(codex, true);
  });

test('an already loaded Claude profile is foreign only to the Claude install',
  async () => {
    const world = hostWorld();
    world.loadProfile(claudeAppArmorProfile);
    await assert.rejects(world.io.policy(await source(resources.claude.profileFile),
      false, policyTargets.claude), { code: 'RESOURCE_FOREIGN_POLICY' });
    assert.equal(world.runs.length, 0);
    assert(!world.nodes.has('/etc/apparmor.d/nibfin-managed-claude'));
    await world.io.policy(await source('codex-security.apparmor'), false);
    assert.equal(world.runs.length, 1);
  });

test('pristine refuses a foreign Claude policy only when Claude is requested',
  async () => {
    const pristine = async (change, options) => {
      const world = hostWorld();
      change(world);
      return world.io.pristine(options);
    };
    const none = () => {};
    const file = path => world => world.nodes.set(path,
      { kind: 'file', mode: 0o644, uid: 0, gid: 0, nlink: 1, bytes: 'foreign' });
    const loaded = name => world => world.loadProfile(name);
    await pristine(none);
    await pristine(none, { claude: true });
    for (const [change, code] of [
      [file(policyTargets.claude.path), 'RESOURCE_FOREIGN_CONFIGURATION'],
      [loaded(claudeAppArmorProfile), 'RESOURCE_FOREIGN_POLICY']]) {
      await pristine(change);
      await pristine(change, { claude: false });
      await assert.rejects(pristine(change, { claude: true }), { code });
    }
    for (const [change, code] of [
      [file(policyTargets.codex.path), 'RESOURCE_FOREIGN_CONFIGURATION'],
      [file(resourcePreparationGate), 'RESOURCE_FOREIGN_CONFIGURATION'],
      [loaded(codexName), 'RESOURCE_FOREIGN_POLICY']])
      for (const options of [undefined, { claude: true }])
        await assert.rejects(pristine(change, options), { code });
  });

test('the state directory admits the Claude proof and still refuses unknown files',
  async () => {
    const world = hostWorld();
    await world.io.initialize();
    await world.io.policy(await source('codex-security.apparmor'), false);
    await world.io.policy(await source(resources.claude.profileFile), false,
      policyTargets.claude);
    await world.io.initialize();
    const entry = { kind: 'file', mode: 0o600, uid: 0, gid: 0, nlink: 1, bytes: '' };
    for (const name of ['state.json', 'recovery.lock'])
      world.nodes.set(`${resources.state}/${name}`, { ...entry });
    await world.io.initialize();
    world.nodes.set(`${resources.state}/policy-other.json`, { ...entry });
    await assert.rejects(world.io.initialize(), { code: 'ENGINE_UNEXPECTED_RESOURCE' });
  });

test('the live check confines the Claude image as Core does and drives the ' +
  'bootstrap probes', () => {
  const args = confinement();
  const option = value => args.some((arg, index) =>
    arg === '--security-opt' && args[index + 1] === value);
  assert(option(`apparmor=${claudeAppArmorProfile}`));
  assert(option('no-new-privileges'));
  const seccomp = args.find(arg => arg.startsWith('seccomp=')).slice(8);
  assert(seccomp.replaceAll('\\', '/').endsWith('/src/security/seccomp.json'));
  for (const [flag, value] of [['--cap-drop', 'ALL'], ['--user', '1000:1000'],
    ['--network', 'none']])
    assert.equal(args[args.indexOf(flag) + 1], value, flag);
  assert(args.includes('--read-only'));
  assert(probeModule.includes("import { denialProbe } from '/input/bootstrap.mjs';"));
  assert(probeModule.includes("await denialProbe('127.0.0.1')"));
  assert(!/environ|bwrap|spawn/.test(probeModule));
});
