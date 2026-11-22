import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prepareSharedGateway } from '../src/shared-gateway-setup.mjs';
import { join } from 'node:path';
import { coreRoot } from '../src/host-adoption.mjs';

const profile = { agent: { image: `sha256:${'a'.repeat(64)}` } };
const runner = { repositoryId: 87, runnerId: 14 };
const uplink = 'reviewed-egress';
const name = 'nibfin-gateway-87-14';
const gatewayId = 'b'.repeat(64);

function fixture() {
  const networks = new Map([[uplink, { Name: uplink, Id: 'egress',
    Driver: 'bridge', Internal: false }]]);
  const containers = new Map();
  const mutations = [];
  const option = (args, name) => args[args.indexOf(name) + 1];
  const docker = async args => {
    const [kind, operation] = args;
    const network = kind === 'network';
    const registry = network ? networks : containers;
    if (operation === 'ls')
      return [...registry.entries()].map(([name, item]) => JSON.stringify({
        [network ? 'Name' : 'Names']: name, ID: item.Id,
      })).join('\n');
    if (operation === 'inspect')
      return JSON.stringify([...registry.values()].filter(item => item.Id === args[2]));
    mutations.push(args);
    if (operation === 'create') {
      const [label, marker] = option(args, '--label').split('=');
      const [key, value] = option(args, '--opt').split('=');
      networks.set(name, { Name: name, Id: 'isolated', Driver: 'bridge',
        Internal: true, Labels: { [label]: marker }, Options: { [key]: value } });
      throw new Error('simulated lost network create reply');
    }
    assert.equal(kind, 'run');
    const labels = args.flatMap((arg, index) =>
      arg === '--label' ? [args[index + 1].split('=')] : []);
    containers.set(name, {
      Id: gatewayId, Name: '/' + name, State: { Running: true },
      Config: { Labels: Object.fromEntries(labels) },
      NetworkSettings: { Networks: {
        [name]: { NetworkID: 'isolated' }, [uplink]: { NetworkID: 'egress' },
      } },
    });
    throw new Error('simulated lost gateway run reply');
  };
  return { docker, mutations, networks, containers };
}

test('read back both named resources after a lost reply and reuse them', async () => {
  const { docker, mutations } = fixture();
  const profileWithGateway = await prepareSharedGateway(profile, runner, uplink, docker);
  assert.equal(profileWithGateway.agent.gatewayId, gatewayId);
  assert.equal(profileWithGateway.agent.network, name);
  assert.equal(mutations.length, 2);
  assert.deepEqual(await prepareSharedGateway(profile, runner, uplink, docker),
    profileWithGateway);
  assert.equal(mutations.length, 2);
});

test('leave a conflicting network or stopped gateway untouched', async () => {
  const { docker, mutations, networks, containers } = fixture();
  await prepareSharedGateway(profile, runner, uplink, docker);
  const installed = networks.get(name);
  networks.set(name, { ...installed, Labels: {} });
  await assert.rejects(prepareSharedGateway(profile, runner, uplink, docker),
    { code: 'SHARED_GATEWAY_NETWORK_CONFLICT' });
  networks.set(name, installed);
  containers.get(name).State.Running = false;
  await assert.rejects(prepareSharedGateway(profile, runner, uplink, docker),
    { code: 'SHARED_GATEWAY_CONTAINER_CONFLICT' });
  assert.equal(mutations.length, 2);
});

const proxyScript = join(coreRoot, 'src/egress-proxy.mjs');
const proxyMount = `type=bind,src=${proxyScript},dst=/proxy.mjs,readonly`;
const gatewayRun = (marker, environment = []) => ['run', '--detach',
  '--pull=never', '--name', name, '--network', name, '--network', uplink,
  '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
  '--label', `io.nibfin.runner=87-14`, '--label', `io.nibfin.gateway-install=${marker}`,
  '--mount', proxyMount, ...environment, '--entrypoint', 'node', profile.agent.image,
  '/proxy.mjs'];
const networkCreate = marker => ['network', 'create', '--driver', 'bridge',
  '--internal', '--opt', 'com.docker.network.bridge.gateway_mode_ipv4=isolated',
  '--label', `io.nibfin.gateway-install=${marker}`, name];
const codexMarker = '8c5a5ae1cea79ad17cdd09d3722c6421dc903547cc4661e9c1bde9a2f1809d04';
const claudeMarker = 'fbf45c178e61964ac27da0db5e4e198cad95d7b49fb46cd3f8a553ea085a4183';

// Captured from origin/main before the gateway provider selection was added.
test('Codex gateway run arguments and marker stay byte-identical', async () => {
  for (const options of [undefined, {}, { provider: 'codex' }]) {
    const { docker, mutations } = fixture();
    await prepareSharedGateway(profile, runner, uplink, docker, options);
    assert.deepEqual(mutations,
      [networkCreate(codexMarker), gatewayRun(codexMarker)]);
  }
});

test('Claude gateway selects its hosts by env and its own marker', async () => {
  const { docker, mutations, networks } = fixture();
  const prepared = await prepareSharedGateway(profile, runner, uplink, docker,
    { provider: 'claude' });
  assert.deepEqual(mutations, [networkCreate(claudeMarker),
    gatewayRun(claudeMarker, ['--env', 'NIBFIN_EGRESS_PROVIDER=claude'])]);
  assert.equal(prepared.agent.gatewayId, gatewayId);
  assert.equal(prepared.agent.provider, undefined);
  // A Codex gateway already on the slot is never reused for Claude, or back.
  await assert.rejects(prepareSharedGateway(profile, runner, uplink, docker),
    { code: 'SHARED_GATEWAY_NETWORK_CONFLICT' });
  networks.delete(name);
  const codex = fixture();
  await prepareSharedGateway(profile, runner, uplink, codex.docker);
  await assert.rejects(prepareSharedGateway(profile, runner, uplink, codex.docker,
    { provider: 'claude' }), { code: 'SHARED_GATEWAY_NETWORK_CONFLICT' });
});

test('an unknown gateway provider is refused before any Docker call', async () => {
  for (const provider of ['other', '', 'Claude', null]) {
    let calls = 0;
    await assert.rejects(prepareSharedGateway(profile, runner, uplink,
      async () => { calls++; return ''; }, { provider }),
    { code: 'SHARED_GATEWAY_SETUP_INVALID' });
    assert.equal(calls, 0);
  }
});
