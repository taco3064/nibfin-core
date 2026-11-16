import { verifySharedSlotIdentity } from './shared-slot-identity.mjs';
import { readdir, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { command } from './process.mjs';
import { rootOwnedPath } from './host-paths.mjs';
import { requireThat } from './identity.mjs';
import {
  observeRetirementUnit, assertRetirementCgroups, slotUnit,
} from './retirement-observe.mjs';

export const retirementServiceEffects = ['service-stop-1', 'service-stop-2'];

async function serviceProcesses(group) {
  requireThat(group.startsWith('/system.slice/') && !group.includes('//') &&
    group.split('/').every(part => part !== '.' && part !== '..'),
  'RETIREMENT_CGROUP_UNKNOWN');
  const root = '/sys/fs/cgroup' + group;
  const pids = [];
  let count = 0;
  const walk = async directory => {
    requireThat(++count <= 1024, 'RETIREMENT_CGROUP_UNKNOWN');
    const entries = (await readFile(join(directory, 'cgroup.procs'), 'utf8'))
      .trim().split('\n').filter(Boolean);
    requireThat(entries.every(pid => /^[1-9][0-9]*$/.test(pid)),
      'RETIREMENT_CGROUP_UNKNOWN');
    pids.push(...entries);
    for (const entry of await readdir(directory, { withFileTypes: true }))
      if (entry.isDirectory()) await walk(join(directory, entry.name));
  };
  await walk(root);
  return [...new Set(pids)].sort();
}

async function readProcess(pid) {
  const root = `/proc/${pid}`;
  const start = async () => (await readFile(join(root, 'stat'), 'utf8'))
    .split(') ').at(-1).split(' ')[19];
  const before = await start();
  const exe = await realpath(join(root, 'exe'));
  const cwd = await realpath(join(root, 'cwd'));
  const argv = (await readFile(join(root, 'cmdline'), 'utf8')).split('\0');
  if (argv.at(-1) === '') argv.pop();
  const status = await readFile(join(root, 'status'), 'utf8');
  requireThat(before === await start(), 'RETIREMENT_PROCESS_CHANGED');
  const uid = status.match(/^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$/m);
  requireThat(uid && new Set(uid.slice(1)).size === 1, 'RETIREMENT_PROCESS_CHANGED');
  return { pid, start: before, exe, cwd, argv, uid: Number(uid[1]),
    parent: status.match(/^PPid:\s+(\d+)$/m)?.[1] };
}

export class RetirementServices {
  constructor({ run = command, inspect = rootOwnedPath,
    processes = serviceProcesses, process = readProcess,
    cgroups = assertRetirementCgroups, registration = verifySharedSlotIdentity } = {}) {
    Object.assign(this, { run, inspect, processes, process, cgroups, registration });
  }
  async supervisors(slot, state, unit) {
    const binding = state.binding.slots[slot - 1], path = binding.path;
    requireThat(unit.ControlGroup.endsWith('/' + slotUnit(slot)),
      'RETIREMENT_CGROUP_UNKNOWN');
    const pids = await this.processes(unit.ControlGroup);
    requireThat(pids.length === 3 && pids.includes(unit.MainPID),
      'RETIREMENT_LOCAL_WORK_PENDING');
    const observations = await Promise.all(pids.map(pid => this.process(pid)));
    const main = observations.find(p => p.pid === unit.MainPID);
    const node = observations.find(p => p.parent === main.pid);
    const listener = node && observations.find(p => p.parent === node.pid);
    const script = value => value === 'bin/runsvc.sh' ||
      value === './bin/runsvc.sh' || value === path + '/bin/runsvc.sh';
    requireThat(main.exe === '/usr/bin/bash' && main.argv.length === 2 &&
      script(main.argv[1]) && node && listener &&
      /^externals\/node(?:20|24)\/bin\/node$/.test(node.exe.slice(path.length + 1)) &&
      node.exe.startsWith(path + '/') && node.argv.length === 2 &&
      ['bin/RunnerService.js', './bin/RunnerService.js', path + '/bin/RunnerService.js']
        .includes(node.argv[1]) && listener.exe === path + '/bin/Runner.Listener' &&
      listener.argv.slice(1).join(' ') === 'run --startuptype service' &&
      observations.every(p => p.cwd === path && p.uid === binding.uid),
    'RETIREMENT_LOCAL_WORK_PENDING');
    for (const p of observations) await this.inspect(p.exe);
    await this.inspect(path + '/bin/runsvc.sh');
    await this.inspect(path + '/bin/RunnerService.js');
    const current = await this.processes(unit.ControlGroup);
    requireThat(JSON.stringify(current) === JSON.stringify(pids),
      'RETIREMENT_PROCESS_CHANGED');
    for (const p of observations)
      requireThat((await this.process(p.pid)).start === p.start,
        'RETIREMENT_PROCESS_CHANGED');
  }
  async observe(name, state) {
    requireThat(retirementServiceEffects.includes(name), 'RETIREMENT_EFFECT_INVALID');
    const slot = Number(name.at(-1)), binding = state.binding.slots[slot - 1];
    await this.registration(binding.path, binding.runner, state.binding.pool.repository,
      { inspect: this.inspect });
    const unit = await observeRetirementUnit(slot, this.run, { allowActive: true });
    if (unit.ActiveState === 'inactive') {
      await this.cgroups('/sys/fs/cgroup', [slot]);
      return 'done';
    }
    await this.supervisors(slot, state, unit);
    return 'absent';
  }
  async perform(name, state) {
    // Read the exact supervisor-only cgroup again immediately before stopping.
    // A Worker, extra process, active lease or unresolved operation forbids stop.
    requireThat(await this.observe(name, state) === 'absent',
      'RETIREMENT_SERVICE_CHANGED');
    await this.inspect('/usr/bin/systemctl');
    await this.run('/usr/bin/systemctl', ['stop', slotUnit(Number(name.at(-1)))],
      { env: { PATH: '/usr/bin:/bin', LANG: 'C' }, limit: 8192 });
  }
}
