import assert from 'node:assert/strict';
import { engine, engineConfiguration, engineUnit } from '../src/engine-contract.mjs';
import { allocationPlan, verifySubordinateChange } from '../src/engine-subids.mjs';

const service = name => ({
  Id: name, LoadState: 'loaded', ActiveState: 'inactive', SubState: 'dead',
  UnitFileState: 'enabled', FragmentPath: `/usr/lib/systemd/system/${name}`,
  DropInPaths: '', NeedDaemonReload: 'no', Environment: '', EnvironmentFiles: '',
  MainPID: '0', Listen: '', Triggers: '', TriggeredBy: '',
  ExecStart: '{ path=/usr/bin/dockerd ; argv[]=/usr/bin/dockerd -H fd:// ' +
    '--containerd=/run/containerd/containerd.sock ; ignore_errors=no ; }',
});

export function engineFixture(options = {}) {
  const units = {
    'docker.service': { ...service('docker.service'),
      ActiveState: 'active', SubState: 'running', MainPID: '123' },
    'docker.socket': { ...service('docker.socket'), ActiveState: 'active',
      SubState: 'listening', Listen: '/run/docker.sock (Stream)', ExecStart: '' },
    [engine.unit]: { ...service(engine.unit), UnitFileState: 'disabled',
      FragmentPath: engine.unitPath,
      ExecStart: `{ path=${engine.daemon} ; argv[]=${engine.daemon} ` +
        `--config-file=${engine.config} ; ignore_errors=no ; }` },
  };
  if (options.override) units[options.override].DropInPaths = '/etc/override.conf';
  const commands = [];
  const files = new Map();
  const tables = { subuid: '', subgid: '' };
  const identities = { subuid: [0, 1000], subgid: [0, 1000] };
  const namespace = { size: 65536, uidStart: 65536, gidStart: 65536 };
  const accounts = { gid: 987, accounts: {
    'nibfin-remap': { uid: 986, gid: 986 },
    'nibfin-controller': { uid: 985, gid: 985 },
    'nibfin-runner-1': { uid: 984, gid: 984 },
    'nibfin-runner-2': { uid: 983, gid: 983 },
  } };
  let state = null;
  let image;
  let container;
  let label;
  let name;
  let started = false;
  const imageId = `sha256:${'a'.repeat(64)}`;
  const containerId = 'b'.repeat(64);
  const io = {
    units, commands, files, tables,
    get state() { return state; },
    async load() { return structuredClone(state); },
    async save(value, previous) {
      assert.deepEqual(state, previous);
      state = structuredClone(value);
    },
    async pristine() { assert.equal(files.size, 0); },
    async run(path, args) {
      assert.equal(path, '/usr/bin/systemctl');
      const [operation] = args;
      const unitName = args.at(-1);
      if (operation === 'show') return Object.entries(units[unitName])
        .map(([key, value]) => `${key}=${value}`).join('\n');
      commands.push(args.join(' '));
      if (operation === 'daemon-reload') return '';
      const unit = units[unitName];
      assert(unit);
      if (options.uncertain === `${operation}:${unitName}`) throw Error('timeout');
      if (operation === 'mask') {
        unit.LoadState = 'masked';
        unit.UnitFileState = 'masked';
        unit.FragmentPath = '/dev/null';
      } else if (operation === 'stop') {
        unit.ActiveState = 'inactive';
        unit.SubState = 'dead';
        unit.MainPID = '0';
      } else if (operation === 'enable') unit.UnitFileState = 'enabled';
      else if (operation === 'start') {
        assert.equal(units['docker.service'].ActiveState, 'inactive');
        assert.equal(units['docker.socket'].LoadState, 'masked');
        unit.ActiveState = 'active';
        unit.SubState = 'running';
        unit.MainPID = '456';
      } else assert.fail(`Unexpected systemctl operation ${operation}`);
      if (options.responseLost === `${operation}:${unitName}`) throw Error('timeout');
      return '';
    },
    async vendorUnit() {},
    async stockConfiguration() {
      if (options.custom) throw Object.assign(Error(),
        { code: 'ENGINE_STOCK_CUSTOM_CONFIGURATION' });
    },
    async emptyStockData() {},
    async verifyMask(unit) { assert.equal(units[unit].LoadState, 'masked'); },
    async verifyEnabled() { assert.equal(units[engine.unit].UnitFileState, 'enabled'); },
    async daemonProcesses() {},
    async daemonIdentity() {},
    async stockIdentity() {},
    async accounts() { return accounts; },
    async subordinatePlan(owner, previous) {
      return { tables: structuredClone(tables), namespace: allocationPlan(tables,
        identities, { subuid: 986, subgid: 986 }, previous) };
    },
    async installSubordinates(plan, observe) {
      for (const table of ['subuid', 'subgid']) {
        if (!observe) tables[table] = `nibfin-remap:65536:65536\n`;
        verifySubordinateChange(plan.tables[table], tables[table], 65536);
      }
    },
    async resources(owner, observe) {
      for (const [path, bytes] of [[engine.config, engineConfiguration()],
        [engine.unitPath, engineUnit()]]) {
        if (!observe && !files.has(path)) files.set(path, bytes);
        if (files.get(path) !== bytes) throw Object.assign(Error(),
          { code: 'ENGINE_FILE_CONFLICT' });
      }
    },
    async beforeStart() { await io.access(); },
    async access() {
      if (options.unsafeAccess) throw Object.assign(Error(),
        { code: 'RUNNER_DOCKER_ACCESS_FORBIDDEN' });
    },
    async probeRootfs() { return Buffer.from('local-rootfs-double'); },
    async kernelProof() {
      return { uidMap: `0 ${options.badMap ? 0 : namespace.uidStart} 65536`,
        gidMap: `0 ${namespace.gidStart} 65536`, label: 'docker-default (enforce)' };
    },
    async docker(managed, args) {
      if (args[0] === 'info') return JSON.stringify(managed ? {
        ID: 'managed', OSType: 'linux', Architecture: 'x86_64',
        DockerRootDir: `${engine.data}/65536.65536`, LiveRestoreEnabled: false,
        SecurityOptions: ['name=seccomp,profile=builtin', 'name=apparmor',
          'name=userns'], CgroupVersion: '2', CgroupDriver: 'systemd',
        MemoryLimit: true, PidsLimit: true, CpuCfsPeriod: true, CpuCfsQuota: true,
      } : {
        DockerRootDir: '/var/lib/docker', Containers: options.workloads ? 1 : 0,
        Images: 0, Swarm: { LocalNodeState: 'inactive' },
      });
      if (!managed) {
        if (args[0] === 'network') return ['bridge', 'host', 'none'].map(value =>
          JSON.stringify({ Name: value, Driver: value === 'none' ? 'null' : value,
            Scope: 'local' })).join('\n');
        if (args[0] === 'system') return [
          'Images', 'Containers', 'Local Volumes', 'Build Cache',
        ].map(Type => JSON.stringify({ Type, TotalCount: '0' })).join('\n');
        return '';
      }
      if (args[0] === 'image' && args[1] === 'import') {
        image = imageId;
        return image;
      }
      if (args[0] === 'image' && args[1] === 'inspect') return JSON.stringify([
        { Id: image, RepoTags: [io.state.probe.tag] },
      ]);
      if (args[0] === 'create') {
        assert.equal(image, imageId);
        name = args[args.indexOf('--name') + 1];
        label = args[args.indexOf('--label') + 1].split('=')[1];
        container = containerId;
        return container;
      }
      if (args[0] === 'start') { started = true; return container; }
      if (args[0] === 'inspect') return JSON.stringify([{
        Id: container, Image: image, Name: `/${name}`,
        Config: { Labels: { 'nibfin.engine-proof': label } },
        State: { Running: started, Pid: 567 },
      }]);
      if (args[0] === 'ps') return container ?? '';
      if (args[0] === 'rm') { container = null; return ''; }
      if (args[0] === 'image' && args[1] === 'ls') return image ?? '';
      if (args[0] === 'image' && args[1] === 'rm') { image = null; return ''; }
      assert.fail(`Unexpected Docker operation ${args}`);
    },
    get probeResources() { return { image, container }; },
  };
  return io;
}
