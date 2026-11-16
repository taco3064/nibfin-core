import assert from 'node:assert/strict';

export function accountDouble() {
  const groups = [['root', 'x', '0', '']];
  const users = [['root', 'x', '0', '0', 'root', '/root', '/bin/bash']];
  const memberships = new Map();
  const commands = [];
  let next = 900;
  return {
    users, groups, commands, memberships,
    async run(path, args) {
      if (path === '/usr/sbin/groupadd') {
        commands.push([path, args]);
        groups.push([args.at(-1), 'x', String(next--), '']);
      } else if (path === '/usr/sbin/useradd') {
        commands.push([path, args]);
        const name = args.at(-1);
        const id = String(next--);
        users.push([name, 'x', id, id, '', '/nonexistent', '/usr/sbin/nologin']);
        groups.push([name, 'x', id, '']);
        const supplement = args.includes('--groups') ? [groups[1][2]] : [];
        memberships.set(name, [id, ...supplement].join(' '));
      } else if (path === '/usr/bin/getent') {
        if (args[0] === 'shadow') return `${args[1]}:!:1:0:99999:7:::\n`;
        return (args[0] === 'passwd' ? users : groups)
          .map(row => row.join(':')).join('\n');
      } else if (path === '/usr/bin/id') return memberships.get(args[1]);
      else assert.fail(`Unexpected account utility ${path}`);
      return '';
    },
  };
}

