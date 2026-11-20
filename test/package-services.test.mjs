import test from 'node:test';
import assert from 'node:assert/strict';
import { observePackageServices } from '../src/package-services.mjs';

const candidate = '/opt/nibfin/core-before-' + 'a'.repeat(40);
const missing = async () => { throw Object.assign(new Error(), { code: 'ENOENT' }); };

test('stopped service ExecCondition retains its candidate source', async () => {
  const result = await observePackageServices(candidate, {
    canonical: missing,
    run: async args => {
      if (args[0] === 'list-unit-files') return 'nibfin.service disabled\n';
      if (args[0] === 'list-units')
        return 'nibfin.service loaded inactive dead\n';
      assert.equal(args[0], 'show');
      const properties = args.find(arg => arg.startsWith('--property='))
        .slice('--property='.length).split(',');
      return properties.includes('ExecCondition') ?
        `ExecCondition={ path=${candidate}/check; argv[]=${candidate}/check; }\n` :
        'ExecStart=/usr/bin/true\n';
    },
  });
  assert.deepEqual(result, { used: true, reason: 'PACKAGE_SERVICE_REFERENCE' });
});

for (const stopped of [true, false]) {
  test(`service references retain source, stopped=${stopped}`, async () => {
    const calls = [];
    const result = await observePackageServices(candidate, {
      canonical: missing,
      run: async args => {
        calls.push(args[0]);
        if (args[0] === 'list-unit-files') return 'nibfin.service disabled\n';
        if (args[0] === 'list-units') return stopped ? '' : 'nibfin.service loaded\n';
        if (args[0] === 'show') return `ExecStart=${candidate}/run\n`;
        return '';
      },
    });
    assert.equal(result.reason, 'PACKAGE_SERVICE_REFERENCE');
    assert.ok(calls.includes('show')); 
  });
}

test('service failures retain without exposing diagnostics', async () => {
  const result = await observePackageServices(candidate, {
    run: async () => { throw new Error('private unit data'); },
  });
  assert.deepEqual(result,
    { used: true, reason: 'PACKAGE_SERVICE_VISIBILITY_INCOMPLETE' });
});

test('service path boundaries preserve unrelated candidates', async () => {
  assert.deepEqual(await observePackageServices(candidate, {
    canonical: missing,
    run: async args => args[0] === 'list-unit-files' ? 'nibfin.service disabled\n' :
      args[0] === 'show' ? `ExecStart=${candidate}-unrelated/run\n` : '',
  }), { used: false });
});

test('inactive masked units cannot select source and do not block other cleanup',
  async () => {
    assert.deepEqual(await observePackageServices(candidate, {
      run: async args => {
        if (args[0] === 'list-unit-files') return 'masked.service masked\n';
        assert.equal(args[0], 'list-units');
        return 'masked.service masked inactive dead\n';
      },
    }), { used: false });
  });

test('template source remains protected while comments do not create references',
  async () => {
    let command = `/usr/bin/node ${candidate}/run`;
    const ports = { canonical: missing, run: async args => {
      if (args[0] === 'list-unit-files') return 'nibfin@.service disabled\n';
      if (args[0] === 'cat')
        return `# Old source ${candidate}/unused\nExecStart=${command}\n`;
      return '';
    } };
    assert.equal((await observePackageServices(candidate, ports)).reason,
      'PACKAGE_SERVICE_REFERENCE');
    command = '/usr/bin/true';
    assert.deepEqual(await observePackageServices(candidate, ports), { used: false });
  });

test('effective service properties avoid retaining overridden commands', async () => {
  assert.deepEqual(await observePackageServices(candidate, {
    canonical: missing,
    run: async args => {
      if (args[0] === 'list-unit-files') return 'nibfin.service disabled\n';
      assert.notEqual(args[0], 'cat');
      return args[0] === 'show' ? 'ExecStart=/usr/bin/true\n' : '';
    },
  }), { used: false });
});

test('service root mappings and unresolved selections retain candidate source',
  async () => {
    for (const value of [
      `RootDirectory=/opt\nExecStart=${candidate.slice(4)}/run\n`,
      'ExecStart=/usr/bin/node $CORE_SCRIPT\n',
    ]) {
      assert.equal((await observePackageServices(candidate, {
        canonical: missing,
        run: async args => args[0] === 'list-unit-files' ? 'nibfin.service disabled\n' :
          args[0] === 'show' ? value : '',
      })).used, true);
    }
    assert.equal((await observePackageServices(candidate, {
      canonical: missing,
      run: async args => args[0] === 'list-unit-files' ? 'nibfin@.service enabled\n' :
        args[0] === 'cat' ? 'ExecStart=/opt/nibfin/core-before-%i/run\n' : '',
    })).reason, 'PACKAGE_SERVICE_VISIBILITY_INCOMPLETE');
  });
