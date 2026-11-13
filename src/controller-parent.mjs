import { readFile } from 'node:fs/promises';
import { requireThat } from './identity.mjs';
import {
  controllerRelayArguments,
  controllerRelayProgram,
  controllerRunnerUids,
} from './controller-contract.mjs';

const denial = 'CONTROLLER_PARENT_UNPROVEN';

function numbers(status, key, count) {
  const rows = [...status.matchAll(new RegExp(`^${key}:[ \\t]*([^\\n]*)$`, 'gm'))];
  requireThat(rows.length === 1, denial);
  const text = rows[0][1].trim();
  if (key === 'Groups' && text === '') return [];
  requireThat(/^\d+(?:[ \t]+\d+)*$/.test(text), denial);
  const values = text.split(/[ \t]+/).map(Number);
  requireThat(
    values.every(Number.isSafeInteger) &&
      (count === undefined || values.length === count),
    denial,
  );
  return values;
}

function statIdentity(text) {
  const row = /^(\d+) \(.*\) ([A-Za-z]) (\d+) (.*)$/s.exec(text.trim());
  requireThat(row, denial);
  const fields = row[4].split(' ');
  const start = fields[17];
  requireThat(/^\d+$/.test(start ?? ''), denial);
  return { pid: Number(row[1]), ppid: Number(row[3]), start };
}

function statusIdentity(status) {
  return {
    pid: numbers(status, 'Pid', 1)[0],
    ppid: numbers(status, 'PPid', 1)[0],
    tracer: numbers(status, 'TracerPid', 1)[0],
    uids: numbers(status, 'Uid', 4),
    gids: numbers(status, 'Gid', 4),
    groups: numbers(status, 'Groups').sort((a, b) => a - b),
  };
}

const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

async function snapshot(pid, read) {
  const before = statIdentity(await read(`/proc/${pid}/stat`, 'utf8'));
  const status = statusIdentity(await read(`/proc/${pid}/status`, 'utf8'));
  const after = statIdentity(await read(`/proc/${pid}/stat`, 'utf8'));
  requireThat(
    same(before, after) && before.pid === pid && status.pid === pid &&
      status.ppid === before.ppid,
    denial,
  );
  return { ...status, start: before.start };
}

// Root is already the host TCB. Only this controller's kernel-proven privileged
// direct parent may carry the Runner real UID with Controller socket groups.
// argv narrows that identity; it does not authenticate an executable. In
// particular, /proc/<root-pid>/exe is not readable by the Controller on Linux.
export async function controllerParentGuard(
  host,
  { read = readFile, pid = process.pid, uid = process.getuid() } = {},
) {
  requireThat(uid === host.uid, denial);
  const self = await snapshot(pid, read);
  requireThat(self.uids.every((id) => id === host.uid) && self.tracer === 0, denial);
  const parent = await snapshot(self.ppid, read);
  const runnerUids = controllerRunnerUids(host);
  if (!parent.uids.some(uid => runnerUids.includes(uid))) return null;
  requireThat(
    runnerUids.includes(parent.uids[0]) &&
      same(parent.uids.slice(1), [0, 0, 0]) && parent.tracer === 0 &&
      self.gids.every((gid) => gid === self.gids[0]) &&
      parent.gids.every((gid) => gid === self.gids[0]) &&
      same(parent.groups, self.groups),
    denial,
  );
  const argv = [controllerRelayProgram, ...controllerRelayArguments(host.uid)];
  const expected = `${argv.join('\0')}\0`;
  requireThat(await read(`/proc/${parent.pid}/cmdline`, 'utf8') === expected, denial);

  async function check() {
    requireThat(
      same(await snapshot(pid, read), self) &&
        same(await snapshot(parent.pid, read), parent) &&
        await read(`/proc/${parent.pid}/cmdline`, 'utf8') === expected,
      denial,
    );
  }

  await check();
  return {
    pid: parent.pid,
    check,
    verifyStatus(status) {
      const identity = statusIdentity(status);
      const { start, ...expectedIdentity } = parent;
      requireThat(same(identity, expectedIdentity), denial);
    },
  };
}
