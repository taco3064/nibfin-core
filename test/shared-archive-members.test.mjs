import test from 'node:test';
import assert from 'node:assert/strict';
import { sharedArchiveMember, sharedArchiveMembers }
  from '../src/shared-archive-members.mjs';
import { sharedArchiveMember as compatibilityMember }
  from '../src/shared-artifacts.mjs';

async function collect(iterator) {
  const result = [];
  for await (const entry of iterator) result.push(entry);
  return result;
}

test('archive member selection accepts exactly one canonical member', () => {
  assert.equal(compatibilityMember, sharedArchiveMember);
  assert.equal(sharedArchiveMember('./bin/worker\n', 'bin/worker'), './bin/worker');
  for (const listing of ['', 'bin/worker\n./bin/worker\n',
    'bin/worker\nbin/worker\n', '../bin/worker\n']) {
    assert.throws(() => sharedArchiveMember(listing, 'bin/worker'),
      { code: 'INVALID_SHARED_ARCHIVE_MEMBERS' });
  }
});

test('trusted tar transport preserves policy and extracts members lazily', async () => {
  const observed = [];
  const iterator = sharedArchiveMembers('/verified/archive', ['bin/one', 'bin/two'], {
    inspect: async path => observed.push(path),
    run: async (path, args, options) => {
      observed.push({ path, args, options });
      return { stdout: Buffer.from(args[0] === '--list'
        ? './bin/one\nbin/two\n' : 'member bytes') };
    },
  });
  assert.equal(observed.length, 0);
  assert.deepEqual((await iterator.next()).value,
    { member: 'bin/one', bytes: Buffer.from('member bytes') });
  assert.equal(observed[0], '/usr/bin/tar');
  assert.equal(observed.length, 3);
  assert.deepEqual(observed[1], { path: '/usr/bin/tar',
    args: ['--list', '--file', '/verified/archive'],
    options: { env: { PATH: '/usr/bin:/bin', LANG: 'C' },
      limit: 256 * 1024 * 1024 } });
  assert.deepEqual(observed[2].args, ['--extract', '--to-stdout', '--file',
    '/verified/archive', '--', './bin/one']);
  await iterator.return();
  assert.equal(observed.length, 3);
});

test('missing or duplicate members never reach tar extraction', async () => {
  for (const listing of ['bin/other\n', 'bin/one\n./bin/one\n']) {
    const calls = [];
    await assert.rejects(collect(sharedArchiveMembers('/archive', ['bin/one'], {
      inspect: async () => {},
      run: async (_path, args) => {
        calls.push(args);
        return { stdout: Buffer.from(listing) };
      },
    })), { code: 'INVALID_SHARED_ARCHIVE_MEMBERS' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], '--list');
  }
});

test('tar trust, listing and extraction errors propagate without fallback', async () => {
  for (const failure of ['trust', 'listing', 'extraction']) {
    const error = new Error(failure);
    const calls = [];
    await assert.rejects(collect(sharedArchiveMembers('/archive', ['bin/one'], {
      inspect: async () => { if (failure === 'trust') throw error; },
      run: async (_path, args) => {
        calls.push(args);
        if (failure === 'listing' || args[0] === '--extract') throw error;
        return { stdout: Buffer.from('bin/one\n') };
      },
    })), error);
    assert.equal(calls.length,
      failure === 'trust' ? 0 : failure === 'listing' ? 1 : 2);
  }
});
