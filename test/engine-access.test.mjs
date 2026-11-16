import assert from 'node:assert/strict';
import { test } from 'node:test';
import { engineAccess, verifyExclusiveEngineProcess } from '../src/engine-access.mjs';
import { engineAccounts } from '../src/engine-accounts.mjs';
import { engine } from '../src/engine-contract.mjs';
import { accountDouble } from './engine-account-fixture.mjs';

async function fixture(options = {}) {
  const io = accountDouble();
  const accounts = await engineAccounts(io);
  const run = io.run;
  const acl = 'user::rw-\ngroup::rw-\nother::---\n';
  let aclCalls = 0;
  io.run = async (path, args) => {
    if (path !== '/usr/bin/getfacl') return run(path, args);
    aclCalls++;
    if (options.aclUnreadable) throw Object.assign(Error(), { code: 'EACCES' });
    if (options.namedAcl) return acl + 'user:1000:rw-\n';
    if (options.changingAcl && aclCalls > 2) return acl.replace('rw-', 'r--');
    return acl;
  };
  const runner = accounts.accounts[engine.runners[0]];
  let reads = 0;
  const host = {
    async lstat(path) {
      return { uid: 0, gid: accounts.gid, ino: 123, dev: 1,
        mode: path === engine.socket ? options.publicSocket ? 0o666 : 0o660 : 0o710,
        isSocket: () => true };
    },
    async realpath(path) { return options.link ? `${path}.other` : path; },
    async rootOwnedPath() {},
    async readdir() { return ['123']; },
    async readFile() {
      reads++;
      if (options.processUnreadable) throw Object.assign(Error(), { code: 'EACCES' });
      const group = options.staleProcessGroup || options.changingProcess && reads > 1
        ? accounts.gid : runner.gid;
      return `Uid:\t${[runner.uid, runner.uid, runner.uid, runner.uid].join('\t')}\n` +
        `Gid:\t${[group, group, group, group].join('\t')}\nGroups:\t${group}\n`;
    },
  };
  return { io, accounts, host };
}

test('actual access verifier checks canonical socket, ACLs and live Runner credentials',
  async () => {
    const { io, accounts, host } = await fixture();
    await engineAccess(io, accounts, host);
  });

test('public, linked, named, unreadable and changing socket evidence fail closed',
  async () => {
    for (const [options, code] of [
      [{ publicSocket: true }, 'UNTRUSTED_DOCKER_SOCKET'],
      [{ link: true }, 'UNTRUSTED_DOCKER_SOCKET'],
      [{ namedAcl: true }, 'RUNNER_SOCKET_ACL_UNPROVEN'],
      [{ aclUnreadable: true }, 'EACCES'],
      [{ changingAcl: true }, 'ENGINE_SOCKET_ACCESS_CHANGED'],
      [{ staleProcessGroup: true }, 'RUNNER_DOCKER_ACCESS_FORBIDDEN'],
      [{ changingProcess: true }, 'ENGINE_PROCESS_ACCESS_CHANGED'],
      [{ processUnreadable: true }, 'EACCES'],
    ]) {
      const { io, accounts, host } = await fixture(options);
      await assert.rejects(engineAccess(io, accounts, host), { code });
    }
  });

test('retained Engine groups on other unprivileged processes are also refused', () => {
  const status = (uids, gids) => `Uid:\t${uids.join(' ')}\n` +
    `Gid:\t${gids.join(' ')}\nGroups:\t987\n`;
  assert.throws(() => verifyExclusiveEngineProcess(
    status([1001, 1001, 1001, 1001], [1001, 1001, 1001, 1001]), 900, 987),
  { code: 'ENGINE_UNEXPECTED_PROCESS_ACCESS' });
  verifyExclusiveEngineProcess(status([900, 900, 900, 900], [900, 900, 900, 900]),
    900, 987);
  verifyExclusiveEngineProcess(status([1001, 0, 0, 0], [1001, 0, 0, 0]), 900, 987);
});
