import { requireThat } from './identity.mjs';
import { engine } from './engine-contract.mjs';
import { allocationPlan, verifySubordinateChange } from './engine-subids.mjs';

export async function accountRows(io, database) {
  const text = await io.run('/usr/bin/getent', [database]);
  const rows = text.trim().split('\n').map(line => line.split(':'));
  requireThat(rows.length > 0 && rows.every(row => row.length ===
    (database === 'passwd' ? 7 : 4) && /^[0-9]+$/.test(row[2])),
  'ENGINE_ACCOUNTS_UNPROVEN');
  return rows;
}

function single(rows, name) {
  const found = rows.filter(row => row[0] === name);
  requireThat(found.length <= 1, 'ENGINE_ACCOUNT_CONFLICT');
  return found[0];
}

export async function engineAccounts(io, observeOnly = false, expected) {
  let groups = await accountRows(io, 'group');
  let access = single(groups, engine.group);
  if (!access) {
    requireThat(!observeOnly, 'ENGINE_ACCOUNT_RECONCILIATION_REQUIRED');
    await io.run('/usr/sbin/groupadd', ['--system', engine.group]).catch(() => {});
    groups = await accountRows(io, 'group');
    access = single(groups, engine.group);
  }
  requireThat(access && Number(access[2]) > 0 && Number(access[2]) < 65536 &&
    groups.filter(row => row[2] === access[2]).length === 1 &&
    ['', engine.controller].includes(access[3]), 'ENGINE_ACCESS_GROUP_CONFLICT');
  const result = { gid: Number(access[2]), accounts: {} };
  for (const name of [engine.remap, engine.controller, ...engine.runners]) {
    let users = await accountRows(io, 'passwd');
    let user = single(users, name);
    if (!user) {
      requireThat(!observeOnly && !single(groups, name), 'ENGINE_ACCOUNT_CONFLICT');
      const supplement = name === engine.controller ? ['--groups', engine.group] : [];
      await io.run('/usr/sbin/useradd', [
        '--system', '--user-group', '--no-create-home', '--home-dir', '/nonexistent',
        '--shell', '/usr/sbin/nologin', ...supplement, name,
      ]).catch(() => {});
      users = await accountRows(io, 'passwd');
      groups = await accountRows(io, 'group');
      user = single(users, name);
    }
    const group = single(groups, name);
    const shadow = (await io.run('/usr/bin/getent', ['shadow', name])).split(':');
    requireThat(user && Number(user[2]) > 0 && Number(user[2]) < 65536 &&
      Number(user[3]) > 0 && Number(user[3]) < 65536 &&
      user[5] === '/nonexistent' && user[6] === '/usr/sbin/nologin' &&
      users.filter(row => row[2] === user[2]).length === 1 &&
      group?.[2] === user[3] && group[3] === '' &&
      groups.filter(row => row[2] === user[3]).length === 1 &&
      shadow[0] === name && /^[!*]/.test(shadow[1]), 'ENGINE_ACCOUNT_CONFLICT');
    const memberships = (await io.run('/usr/bin/id', ['-G', name]))
      .trim().split(/\s+/).map(Number).sort((a, b) => a - b);
    const intended = [Number(user[3]), ...(name === engine.controller
      ? [result.gid] : [])].sort((a, b) => a - b);
    requireThat(JSON.stringify(memberships) === JSON.stringify(intended),
      'ENGINE_ACCOUNT_GROUP_CONFLICT');
    result.accounts[name] = { uid: Number(user[2]), gid: Number(user[3]) };
  }
  const users = await accountRows(io, 'passwd');
  groups = await accountRows(io, 'group');
  requireThat(users.every(user => Number(user[3]) !== result.gid),
    'ENGINE_ACCESS_GROUP_CONFLICT');
  if (expected) requireThat(JSON.stringify(result) === JSON.stringify(expected),
    'ENGINE_ACCOUNT_CONFIGURATION_CHANGED');
  return result;
}

export async function subordinatePlan(io, accounts, previous) {
  const users = await accountRows(io, 'passwd');
  const groups = await accountRows(io, 'group');
  const tables = {};
  for (const name of ['subuid', 'subgid']) tables[name] = await io.subordinate(name);
  const remap = accounts.accounts[engine.remap];
  return {
    tables,
    namespace: allocationPlan(tables, {
      subuid: users.map(row => Number(row[2])),
      subgid: [...groups.map(row => Number(row[2])),
        ...users.map(row => Number(row[3]))],
    }, { subuid: remap.uid, subgid: remap.gid }, previous),
  };
}

export async function installSubordinates(io, plan, observeOnly) {
  for (const [table, field, flag] of [
    ['subuid', 'uidStart', '--add-subuids'],
    ['subgid', 'gidStart', '--add-subgids'],
  ]) {
    const start = plan.namespace[field];
    let current = await io.subordinate(table);
    if (current === plan.tables[table] &&
      !current.split('\n').some(line => line.startsWith(`${engine.remap}:`))) {
      requireThat(!observeOnly, 'ENGINE_SUBID_RECONCILIATION_REQUIRED');
      await io.run('/usr/sbin/usermod', [
        flag, `${start}-${start + plan.namespace.size - 1}`, engine.remap,
      ]).catch(() => {});
      current = await io.subordinate(table);
    }
    verifySubordinateChange(plan.tables[table], current, start);
  }
}
