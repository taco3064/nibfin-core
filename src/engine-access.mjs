import { lstat, realpath, readdir, readFile } from 'node:fs/promises';
import { requireThat } from './identity.mjs';
import { rootOwnedPath } from './host-paths.mjs';
import { engine } from './engine-contract.mjs';
import { accountRows, engineAccounts } from './engine-accounts.mjs';
import { requirePlainAcl, verifyRunnerProcess } from './controller-separation.mjs';
import { verifyDockerSocket } from './docker-backend.mjs';

const nativeAccess = { lstat, realpath, readdir, readFile, rootOwnedPath };

export async function engineAccess(io, accounts, observe = nativeAccess) {
  const { lstat, realpath, rootOwnedPath } = observe;
  await engineAccounts(io, true, accounts);
  const controller = accounts.accounts[engine.controller];
  await verifyDockerSocket(engine.socket, { mode: 'rootful' }, {
    platform: 'linux', uid: controller.uid, gids: [accounts.gid],
    lstat, realpath, rootOwnedPath,
  });
  const before = await lstat(engine.socket);
  const directory = await lstat(engine.runtime);
  requireThat(directory.gid === accounts.gid &&
    (directory.mode & 0o7777) === 0o710, 'ENGINE_PARENT_ACCESS_CONFLICT');
  const acls = [];
  for (const path of [engine.runtime, engine.socket]) {
    const acl = await io.run('/usr/bin/getfacl', ['-cp', path]);
    requirePlainAcl(acl);
    acls.push(acl);
  }
  await engineAccountAccess(io, accounts, observe);
  const after = await lstat(engine.socket);
  requireThat(before.dev === after.dev && before.ino === after.ino &&
    before.mode === after.mode && before.uid === after.uid && before.gid === after.gid,
  'ENGINE_SOCKET_ACCESS_CHANGED');
  const finalDirectory = await lstat(engine.runtime);
  requireThat(finalDirectory.ino === directory.ino &&
    finalDirectory.dev === directory.dev && finalDirectory.mode === directory.mode &&
    finalDirectory.gid === directory.gid && finalDirectory.uid === directory.uid,
  'ENGINE_PARENT_ACCESS_CHANGED');
  for (const [index, path] of [engine.runtime, engine.socket].entries())
    requireThat(await io.run('/usr/bin/getfacl', ['-cp', path]) === acls[index],
      'ENGINE_SOCKET_ACCESS_CHANGED');
  await engineAccounts(io, true, accounts);
}

export async function engineAccountAccess(io, accounts, observe = nativeAccess) {
  const { readdir, readFile } = observe;
  await engineAccounts(io, true, accounts);
  const users = await accountRows(io, 'passwd');
  const groups = await accountRows(io, 'group');
  const access = groups.find(row => Number(row[2]) === accounts.gid);
  requireThat(access && ['', engine.controller].includes(access[3]) &&
    users.every(row => Number(row[3]) !== accounts.gid), 'ENGINE_ACCESS_GROUP_CONFLICT');
  const uids = engine.runners.map(name => accounts.accounts[name].uid);
  for (const pid of (await readdir('/proc')).filter(name => /^[0-9]+$/.test(name))) {
    try {
      const path = `/proc/${pid}/status`;
      const status = await readFile(path, 'utf8');
      for (const uid of uids) verifyRunnerProcess(status, uid, accounts.gid);
      verifyExclusiveEngineProcess(status, accounts.accounts[engine.controller].uid,
        accounts.gid);
      const after = await readFile(path, 'utf8');
      const credentials = text => text.split('\n').filter(line =>
        /^(Uid|Gid|Groups):/.test(line)).join('\n');
      requireThat(credentials(after) === credentials(status),
        'ENGINE_PROCESS_ACCESS_CHANGED');
    } catch (error) {
      if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error;
    }
  }
  await engineAccounts(io, true, accounts);
}

export function verifyExclusiveEngineProcess(status, controllerUid, engineGid) {
  const fields = {};
  for (const key of ['Uid', 'Gid', 'Groups']) {
    const match = new RegExp(`^${key}:[ \t]*([^\n]*)$`, 'm').exec(status);
    requireThat(match && /^[0-9 \t]*$/.test(match[1]),
      'ENGINE_PROCESS_ACCESS_UNPROVEN');
    fields[key] = match[1].trim().split(/\s+/).filter(Boolean).map(Number);
  }
  requireThat(fields.Uid.length === 4 && fields.Gid.length === 4 &&
    Object.values(fields).flat().every(id => Number.isSafeInteger(id) && id >= 0),
    'ENGINE_PROCESS_ACCESS_UNPROVEN');
  // Fully privileged processes are outside the unprivileged controller boundary.
  if (fields.Uid.slice(1).every(uid => uid === 0)) return;
  if ([...fields.Gid, ...fields.Groups].includes(engineGid))
    requireThat(fields.Uid.every(uid => uid === controllerUid),
      'ENGINE_UNEXPECTED_PROCESS_ACCESS');
}
