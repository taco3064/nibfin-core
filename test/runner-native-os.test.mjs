import test from 'node:test';
import assert from 'node:assert/strict';
import { readRunnerBinding } from '../src/runner-binding.mjs';
import { runnerProviderFixture } from './runner-binding-fixture.mjs';

test('native Runner OS casing yields the adopted canonical OS', async () => {
  const hashes = new Set();
  for (const nativeOS of ['linux', 'Linux', 'LINUX']) {
    const f = runnerProviderFixture();
    f.runner.os = nativeOS;
    const result = await readRunnerBinding(f.reader, f.expected);
    assert.equal(result.os, 'linux');
    hashes.add(result.observationHash);
  }
  assert.equal(hashes.size, 3, 'observation must retain the raw native response');
});

test('normalization cannot admit a different or malformed Runner OS', async () => {
  for (const nativeOS of ['Windows', 'macOS', '', 'linux ', null, 42]) {
    const f = runnerProviderFixture();
    f.runner.os = nativeOS;
    await assert.rejects(
      readRunnerBinding(f.reader, f.expected),
      /ACTUAL_RUNNER_BINDING_MISMATCH/,
    );
  }
});

test('raw native OS drift during observation remains rejected', async () => {
  const f = runnerProviderFixture();
  f.runner.os = 'Linux';
  const get = f.reader.get;
  let reads = 0;
  f.reader.get = async (path) => {
    const value = await get(path);
    if (path.endsWith('/actions/runners/40') && ++reads === 2) value.os = 'linux';
    return value;
  };
  await assert.rejects(
    readRunnerBinding(f.reader, f.expected),
    /RUNNER_BINDING_CHANGED_DURING_READ/,
  );
});
