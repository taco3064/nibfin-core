import test from 'node:test';
import assert from 'node:assert/strict';
import {
  codexEnvironment, jobToolEnvironment,
} from '../src/codex-environment.mjs';

const endpoint = { docker: '/usr/bin/docker', socket: '/socket' };
const profile = {
  kind: 'linux-rootless-docker-v1',
  agent: { ...endpoint, image: 'fixed-agent' },
  hooks: { ...endpoint, image: 'fixed-hooks' },
};

test('Job selection coalesces stages and isolates concurrent and sequential Jobs',
  async () => {
    const calls = [];
    class Preparer {
      constructor(config, options) {
        assert.deepEqual(config, endpoint);
        assert.equal(options.backend.mode, 'rootless');
      }
      async prepare(tools) {
        calls.push(tools.node);
        return tools.node === '22.15.0'
          ? `sha256:${'a'.repeat(64)}` : `sha256:${'b'.repeat(64)}`;
      }
    }
    const launch = async (select, tools) => {
      const captured = [];
      class Consumer {
        constructor(config, options) { captured.push({ config, options }); }
      }
      await codexEnvironment(profile, '/core', undefined, { tools }, {
        AgentSandbox: Consumer, HookSandbox: Consumer, toolEnvironment: select,
      });
      return captured;
    };
    const aTools = { node: '22.15.0' }, bTools = { node: '24.22.1' };
    const a = jobToolEnvironment(aTools, Preparer);
    const b = jobToolEnvironment(bTools, Preparer);
    const [first, second, repeated] = await Promise.all([
      launch(a, aTools), launch(b, bTools), launch(a, aTools),
    ]);
    assert.deepEqual(calls.sort(), ['22.15.0', '24.22.1']);
    assert.equal(first[0].config.image, repeated[0].config.image);
    assert.notEqual(first[0].config.image, second[0].config.image);
    for (const observed of [first, second]) {
      assert.equal(observed[0].config.image, observed[1].config.image);
      assert.equal(observed[0].options.gatewayImage, 'fixed-agent');
      assert.equal(observed[1].config.socket, '/socket');
      assert.equal(observed[1].config.network, undefined);
      assert.notEqual(observed[0].config, profile.agent);
      assert.notEqual(observed[1].config, profile.hooks);
    }
    await launch(b, bTools);
    assert.equal(calls.length, 2);
    assert.equal(profile.agent.image, 'fixed-agent');
    assert.equal(profile.hooks.image, 'fixed-hooks');
  });

test('empty declarations retain defaults without constructing a preparer', async () => {
  class Unused { constructor() { assert.fail('unnecessary preparation'); } }
  for (const tools of [undefined, {}]) {
    const selected = jobToolEnvironment(tools, Unused);
    assert.equal(await selected(profile), null);
  }
});

test('failed preparation stays failed within the Job and launches no sandbox',
  async () => {
    const failure = Object.assign(new Error('unknown termination'), {
      code: 'WRITER_TERMINATION_UNKNOWN',
    });
    let attempts = 0;
    class Failed {
      async prepare() { attempts++; throw failure; }
    }
    class Unused { constructor() { assert.fail('fallback launch'); } }
    const select = jobToolEnvironment({ node: '22.15.0' }, Failed);
    for (let stage = 0; stage < 2; stage++) {
      await assert.rejects(codexEnvironment(profile, '/core', undefined, {}, {
        toolEnvironment: select, AgentSandbox: Unused, HookSandbox: Unused,
      }), error => error === failure);
    }
    assert.equal(attempts, 1);
  });
