import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prepareSharedGateway } from '../src/shared-gateway-setup.mjs';

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
