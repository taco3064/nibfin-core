import { lstat, realpath, readdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { command } from './process.mjs';
import { requireThat } from './identity.mjs';
import {
  controllerRoute, controllerRelayProgram, controllerRunnerUids,
} from './controller-contract.mjs';
import { controllerParentGuard } from './controller-parent.mjs';
import { rootOwnedPath } from './host-paths.mjs';
import { rootfulSocket, verifyDockerSocket } from './docker-backend.mjs';

export function requirePlainAcl(text) {
  const rows = text.split('\n').filter((line) => line.length > 0);
  requireThat(
    rows.length === 3 &&
      ['user', 'group', 'other'].every(
        (kind) =>
          rows.filter((line) => new RegExp(`^${kind}::[rwx-]{3}$`).test(line)).length ===
          1,
      ),
    'RUNNER_SOCKET_ACL_UNPROVEN',
  );
}

export function requireRunnerGroups(text, socketGid) {
  requireThat(/^\s*\d+(?:\s+\d+)*\s*$/.test(text), 'RUNNER_PROCESS_GROUPS_UNPROVEN');
  const groups = text.trim().split(/\s+/).map(Number);
  requireThat(
    groups.length > 0 &&
      groups.every(Number.isSafeInteger) &&
      groups.every((gid) => gid >= 0 && gid !== socketGid),
    'RUNNER_DOCKER_ACCESS_FORBIDDEN',
  );
}

export function verifyRunnerProcess(status, runnerUid, socketGid) {
  const uids = /^Uid:[ \t]*(\d+[ \t]+\d+[ \t]+\d+[ \t]+\d+)$/m.exec(status);
  requireThat(uids, 'PROCESS_IDENTITY_UNPROVEN');
  if (!uids[1].split(/\s+/).map(Number).includes(runnerUid)) return;
  const gids = /^Gid:[ \t]*(\d+[ \t]+\d+[ \t]+\d+[ \t]+\d+)$/m.exec(status);
  const groups = /^Groups:[ \t]*([^\n]*)$/m.exec(status);
  requireThat(gids && groups, 'RUNNER_PROCESS_GROUPS_UNPROVEN');
  requireRunnerGroups(`${gids[1]} ${groups[1]}`, socketGid);
}

// Account membership and actual running credentials are separate OS facts.
// A removed supplementary group can persist until a process is restarted.
export async function verifyControllerSeparation(host) {
  if (!controllerRoute(host)) return;
  for (const executable of ['/usr/bin/id', '/usr/bin/getfacl', controllerRelayProgram]) {
    await rootOwnedPath(executable);
  }
  await verifyDockerSocket(
    rootfulSocket,
    { mode: 'rootful' },
    {
      platform: process.platform,
      uid: process.getuid(),
      lstat,
      realpath,
    },
  );
  const socket = await lstat(rootfulSocket);
  const options = { env: { PATH: '/usr/bin:/bin', LANG: 'C' } };
  const runnerUids = controllerRunnerUids(host);
  for (const uid of runnerUids) {
    const account = await command('/usr/bin/id', ['-G', String(uid)], options);
    requireRunnerGroups(account.stdout.toString(), socket.gid);
  }
  for (const path of [dirname(rootfulSocket), rootfulSocket]) {
    const acl = await command('/usr/bin/getfacl', ['-cp', path], options);
    requirePlainAcl(acl.stdout.toString());
  }
  const parent = await controllerParentGuard(host);
  for (const pid of (await readdir('/proc')).filter((name) => /^\d+$/.test(name))) {
    try {
      const status = await readFile(`/proc/${pid}/status`, 'utf8');
      if (Number(pid) === parent?.pid) parent.verifyStatus(status);
      else for (const uid of runnerUids) verifyRunnerProcess(status, uid, socket.gid);
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error;
    }
  }
  await parent?.check();
}
