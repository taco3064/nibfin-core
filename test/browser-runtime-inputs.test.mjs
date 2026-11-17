import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { browserRuntimeProbe } from '../src/browser-runtime-inputs.mjs';

function probe(arch, fault) {
  const calls = [];
  let output = '';
  runInNewContext(browserRuntimeProbe(arch), {
    require(name) {
      if (name === 'node:fs') return { existsSync: () => fault !== 'missing' };
      assert.equal(name, 'node:child_process');
      return { execFileSync(file, args, options) {
        calls.push({ file, args, options });
        if (fault === 'command') throw Error('private diagnostic');
        if (file === '/usr/bin/fc-match') return fault === 'font' ? '' : '/font';
        return fault === 'dependency' ? 'libsecret.so => not found' : 'available';
      } };
    },
    process: { stdout: { write: text => { output += text; } } },
  });
  return { calls, output };
}

test('both Chromium runtime profiles check native libraries and fonts offline', () => {
  for (const [arch, triplet] of [['amd64', 'x86_64'], ['arm64', 'aarch64']]) {
    const { calls, output } = probe(arch);
    assert.equal(output, 'NIBFIN_BROWSER_RUNTIME_VERIFIED\n');
    const libraries = calls.filter(call => call.file === '/usr/bin/ldd');
    assert.equal(libraries.length, 23);
    assert(libraries.every(call => call.args[0].startsWith(
      `/usr/lib/${triplet}-linux-gnu/`)));
    assert(calls.some(call => call.file === '/usr/bin/fc-match'));
    for (const { options } of calls) {
      assert.equal(options.timeout, 5000);
      assert.equal(options.maxBuffer, 65536);
      assert.equal(options.env.PATH, '/usr/bin:/bin');
    }
  }
});

test('missing browser runtime inputs produce bounded errors without downloads', () => {
  for (const fault of ['missing', 'dependency', 'command', 'font'])
    assert.throws(() => probe('arm64', fault),
      { message: 'NIBFIN_BROWSER_RUNTIME_UNAVAILABLE' });
  assert.throws(() => browserRuntimeProbe('s390x'),
    { code: 'RESOURCE_INPUT_PLATFORM_UNSUPPORTED' });
});
