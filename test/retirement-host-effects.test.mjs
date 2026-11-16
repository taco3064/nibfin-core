import test from 'node:test';
import assert from 'node:assert/strict';
import { RetirementServices } from '../src/retirement-services.mjs';
import { RetirementGateways, retirementGatewayEffects }
  from '../src/retirement-gateways.mjs';
import { idleContainers } from '../src/host-containers.mjs';
import { providerHost } from './provider-fixture.mjs';

function servicesFixture() {
  const path = '/var/lib/nibfin/runners/slot-1', uid = 91;
  const state = { binding: { pool: { repository: 'owner/pool' },
    slots: [{ path, uid }] } };
  const unit = { Id: 'nibfin-shared-runner@1.service', LoadState: 'loaded',
    FragmentPath: '/etc/systemd/system/nibfin-shared-runner@.service', DropInPaths: '',
    NeedDaemonReload: 'no', ActiveState: 'active', SubState: 'running', MainPID: '10',
    ControlGroup: '/system.slice/managed.slice/nibfin-shared-runner@1.service',
    User: 'nibfin-runner-1', Group: 'nibfin-runner-1' };
  const processes = [
    { pid: '10', parent: '1', start: '100', uid, cwd: path, exe: '/usr/bin/bash',
      argv: ['/bin/bash', path + '/bin/runsvc.sh'] },
    { pid: '11', parent: '10', start: '101', uid, cwd: path,
      exe: path + '/externals/node24/bin/node',
      argv: ['node', './bin/RunnerService.js'] },
    { pid: '12', parent: '11', start: '102', uid, cwd: path,
      exe: path + '/bin/Runner.Listener',
      argv: ['Runner.Listener', 'run', '--startuptype', 'service'] },
  ];
  const calls = [];
  const services = new RetirementServices({
    inspect: async () => {}, cgroups: async () => {},
    registration: async () => {},
    processes: async () => processes.map(p => p.pid).sort(),
    process: async pid => structuredClone(processes.find(p => p.pid === pid)),
    run: async (_program, args) => {
      calls.push(args);
      if (args[0] === 'stop') Object.assign(unit, {
        ActiveState: 'inactive', SubState: 'dead', MainPID: '0', ControlGroup: '' });
      return { stdout: Buffer.from(Object.entries(unit)
        .map(([key, value]) => `${key}=${value}`).join('\n')) };
    },
  });
  return { services, state, processes, calls, unit };
}

test('service stop accepts only the exact idle supervisor tree and reads termination',
  async () => {
    const f = servicesFixture();
    assert.equal(await f.services.observe('service-stop-1', f.state), 'absent');
    await f.services.perform('service-stop-1', f.state);
    assert.equal(await f.services.observe('service-stop-1', f.state), 'done');
    assert.deepEqual(f.calls.filter(args => args[0] === 'stop'),
      [['stop', 'nibfin-shared-runner@1.service']]);
  });

test('a Worker, unknown child, replaced parent or unstable PID forbids service stop',
  async () => {
    for (const change of [
      f => f.processes.push({ pid: '13', parent: '12' }),
      f => { f.processes[2].exe = '/untrusted/Runner.Listener'; },
      f => { f.processes[1].parent = '12'; },
      f => { f.processes[2].uid = 999; },
      f => { f.unit.ControlGroup = '/outside/service'; },
      f => {
        let reads = 0;
        const original = f.services.process;
        f.services.process = async pid => ({ ...await original(pid),
          start: ++reads > 3 ? 'changed' : String(100 + Number(pid) - 10) });
      },
    ]) {
      const f = servicesFixture(); change(f);
      await assert.rejects(f.services.perform('service-stop-1', f.state));
      assert.equal(f.calls.filter(args => args[0] === 'stop').length, 0);
    }
  });

function gatewayFixture() {
  const host = providerHost(), objects = new Map(), calls = [];
  const marker = 'f'.repeat(64);
  for (const [index, profile] of [host.repository.isolation,
    host.sharedRunner.additionalRunner.isolation].entries()) {
    const gatewayId = String(index + 1).repeat(64);
    const networkId = String(index + 3).repeat(64);
    const name = `managed-slot-${index + 1}`;
    Object.assign(profile.agent, { docker: '/usr/bin/docker', socket: '/run/docker.sock',
      network: name, gatewayId });
    Object.assign(profile.hooks, { docker: profile.agent.docker,
      socket: profile.agent.socket });
    objects.set(gatewayId, { Id: gatewayId,
      State: { Running: true, Restarting: false, Pid: 500 + index },
      Config: { Labels: { 'io.nibfin.gateway-install': marker,
        'io.nibfin.runner': `1-${42 + index}` } },
      NetworkSettings: { Networks: { [name]: { NetworkID: networkId } } } });
    objects.set(networkId, { Id: networkId, Name: name, Driver: 'bridge', Internal: true,
      Labels: { 'io.nibfin.gateway-install': marker }, Containers: { [gatewayId]: {} } });
  }
  const run = async (_program, args) => {
    const command = args.slice(2), [kind, verb] = command;
    calls.push(command);
    if (verb === 'ls') {
      const id = command[command.indexOf('--filter') + 1].slice(3);
      return { stdout: Buffer.from(objects.has(id) ? id : '') };
    }
    if (verb === 'inspect') return { stdout: Buffer.from(JSON.stringify(
      [objects.get(command[2])])) };
    const id = command.at(-1), object = objects.get(id);
    if (verb === 'stop') Object.assign(object.State,
      { Running: false, Restarting: false, Pid: 0 });
    else if (verb === 'rm') {
      assert(kind === 'network' || object.State.Running === false);
      objects.delete(id);
      for (const object of objects.values()) if (object.Containers)
        delete object.Containers[id];
    } else assert.fail('Unexpected fake Docker effect');
    return { stdout: Buffer.from(id) };
  };
  return { host, objects, calls, run,
    gateways: new RetirementGateways(run, async () => {}) };
}

test('matched gateways terminate before removal; exact empty networks read back absent',
  async () => {
    const f = gatewayFixture();
    const state = { gateways: await f.gateways.bind(f.host), effects: {} };
    const unrelated = '9'.repeat(64);
    f.objects.set(unrelated, { Id: unrelated });
    for (const name of retirementGatewayEffects) {
      assert.equal(await f.gateways.observe(name, state), 'absent');
      state.effects[name] = 'intent';
      await f.gateways.perform(name, state);
      assert.equal(await f.gateways.observe(name, state), 'done');
      state.effects[name] = 'done';
    }
    assert.equal(f.objects.size, 1);
    assert(f.objects.has(unrelated));
    assert(f.calls.every(args => !args.includes('--force')));
  });

test('unknown gateway identity and unexpected network consumers forbid deletion',
  async () => {
    const f = gatewayFixture();
    const state = { gateways: await f.gateways.bind(f.host), effects: {} };
    const first = state.gateways[0];
    f.objects.get(first.networkId).Containers['9'.repeat(64)] = {};
    await assert.rejects(f.gateways.perform('gateway-stop-1', state),
      { code: 'RETIREMENT_GATEWAY_IDENTITY_CHANGED' });
    assert.equal(f.calls.filter(args => args[1] === 'stop').length, 0);
    delete f.objects.get(first.networkId).Containers['9'.repeat(64)];
    f.objects.get(first.gatewayId).Config.Labels['io.nibfin.runner'] = 'other';
    await assert.rejects(f.gateways.observe('gateway-stop-1', state),
      { code: 'RETIREMENT_GATEWAY_IDENTITY_CHANGED' });
  });

test('ordinary container settlement still requires its adopted gateway', async () => {
  const f = gatewayFixture(), profile = f.host.repository.isolation;
  const empty = async () => ({ stdout: Buffer.from('') });
  await assert.rejects(idleContainers(profile, undefined, empty),
    { code: 'PREVIOUS_HOST_PROCESS_UNRESOLVED' });
  await idleContainers(profile, undefined, empty, { allowMissingGateway: true });
});
