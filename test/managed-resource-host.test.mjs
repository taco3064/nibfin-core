import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { digest } from '../src/identity.mjs';
import { managedResourceHost } from '../src/managed-resource-host.mjs';
import { managedResources as resources } from '../src/managed-resource-contract.mjs';

const id = 'a'.repeat(64);
const image = `sha256:${id}`;
const agentId = `sha256:${'b'.repeat(64)}`;
const layer = digit => `sha256:${digit.repeat(64)}`;
const agentLayers = [layer('1'), layer('2')];
const state = { owner: 'owned', inputs: 'fixed', images: { agent: agentId } };
const inputs = { 'managed-hook.Dockerfile': 'FROM nibfin-managed-agent-input\n' };
const hookMarker = digest({ owner: state.owner, inputs: state.inputs, kind: 'hooks' });

// Local Docker double: the Agent tag, the Agent ID and one Hook image.
function hookEngine(world) {
  return {
    async docker(managed, args, options) {
      assert.equal(managed, true);
      world.calls.push(args);
      if (args[0] === 'build') {
        world.builds++;
        world.input = options.input;
        assert(args.includes('--no-cache'));
        assert(args.includes('--network=host'));
        assert.equal(args[args.indexOf('--platform') + 1], `linux/${world.arch}`);
        world.exists = true;
        throw new Error('Reply lost after successful build');
      }
      if (args[1] === 'ls') return world.exists ? image : '';
      assert.equal(args[1], 'inspect');
      if (args[2] === world.agentTag) {
        if (world.tagId === null) throw new Error('No such image');
        return JSON.stringify([{ Id: world.tagId }]);
      }
      if (args[2] === agentId)
        return JSON.stringify([{ Id: agentId, RootFS: { Layers: agentLayers } }]);
      assert.equal(args[2], image);
      return JSON.stringify([{ Id: image, Os: 'linux', Architecture: world.arch,
        RootFS: { Layers: world.layers },
        Config: { Labels: { [resources.label]: world.marker } },
        RepoTags: [world.name] }]);
    },
  };
}

function hookWorld(arch = 'amd64') {
  const suffix = arch === 'amd64' ? '' : `-${arch}`;
  return { arch, calls: [], builds: 0, exists: false, tagId: agentId,
    agentTag: `nibfin-managed-resource:agent${suffix}`,
    name: `nibfin-managed-resource:hooks${suffix}`,
    layers: [...agentLayers, layer('3')], marker: hookMarker };
}

test('build binds Hook recipe to the verified Agent tag and refuses unknown effects',
  async () => {
    const world = hookWorld();
    const io = managedResourceHost(async () => {}, hookEngine(world));
    assert.equal(await io.image('hooks', state, inputs, false), image);
    assert.equal(world.input, 'FROM nibfin-managed-resource:agent\n');
    assert(!world.input.includes('sha256:'));
    const tagCheck = world.calls.findIndex(args => args[2] === world.agentTag);
    const build = world.calls.findIndex(args => args[0] === 'build');
    assert(tagCheck >= 0 && tagCheck < build);
    assert.equal(await io.image('hooks', state, inputs, true), image);
    assert.equal(world.builds, 1);
    world.exists = false;
    await assert.rejects(io.image('hooks', state, inputs, true),
      { code: 'RESOURCE_IMAGE_RECONCILIATION_REQUIRED' });
    assert.equal(world.builds, 1);
  });

test('arm64 Hook builds FROM the arm64 Agent tag', async () => {
  const world = hookWorld('arm64');
  const io = managedResourceHost(async () => {}, hookEngine(world));
  const target = { ...state, architecture: 'arm64' };
  assert.equal(await io.image('hooks', target, inputs, false), image);
  assert.equal(world.input, 'FROM nibfin-managed-resource:agent-arm64\n');
});

test('Hook build refuses an Agent tag that no longer names the prepared ID',
  async () => {
    for (const tagId of [image, null]) {
      const world = { ...hookWorld(), tagId };
      const io = managedResourceHost(async () => {}, hookEngine(world));
      await assert.rejects(io.image('hooks', state, inputs, false),
        { code: 'RESOURCE_IMAGE_CONFLICT' });
      assert.equal(world.builds, 0);
    }
  });

test('Hook image must extend the prepared Agent layers when built or found',
  async () => {
    for (const layers of [[layer('3')], [layer('1')], [layer('2'), layer('1')],
      undefined]) {
      const built = { ...hookWorld(), layers };
      await assert.rejects(managedResourceHost(async () => {}, hookEngine(built))
        .image('hooks', state, inputs, false), { code: 'RESOURCE_IMAGE_CONFLICT' });
      assert.equal(built.builds, 1);
      const found = { ...hookWorld(), layers, exists: true };
      await assert.rejects(managedResourceHost(async () => {}, hookEngine(found))
        .image('hooks', state, inputs, true), { code: 'RESOURCE_IMAGE_CONFLICT' });
      assert.equal(found.builds, 0);
    }
  });

test('owned egress bridge does not depend on the default Docker bridge', async () => {
  let row;
  let creates = 0;
  const io = managedResourceHost(async () => {}, {
    async docker(managed, args) {
      assert.equal(managed, true);
      assert.equal(args[0], 'network');
      if (args[1] === 'ls') return row?.Id ?? '';
      if (args[1] === 'create') {
        creates++;
        assert(args.includes(resources.egress));
        assert(!args.includes('--internal'));
        row = { Id: id, Name: resources.egress, Driver: 'bridge', Scope: 'local',
          Internal: false, Ingress: false, Options: {},
          Labels: { [resources.label]: state.owner } };
        throw new Error('Reply lost');
      }
      assert.equal(args[1], 'inspect');
      return JSON.stringify([row]);
    },
  });
  assert.equal(await io.egress(state.owner, false), id);
  assert.equal(await io.egress(state.owner, true), id);
  assert.equal(creates, 1);
  row.Labels = {};
  await assert.rejects(io.egress(state.owner, true),
    { code: 'RESOURCE_NETWORK_CONFLICT' });
  assert.equal(creates, 1);
  row = null;
  await assert.rejects(io.egress(state.owner, true),
    { code: 'RESOURCE_NETWORK_RECONCILIATION_REQUIRED' });
  assert.equal(creates, 1);
});

test('foreign image labels are never adopted', async () => {
  const world = { ...hookWorld(), exists: true, marker: undefined };
  const io = managedResourceHost(async () => {}, hookEngine(world));
  await assert.rejects(io.image('hooks', state, inputs, true),
    { code: 'RESOURCE_IMAGE_CONFLICT' });
  assert(world.calls.some(args => args[2] === agentId));
});

test('availability checks the fixed Agent runtime and skips model CLI in Hooks',
  async () => {
    const inputs = { versions: { node: '24.22.1', go: '1.27.1', npm: '11.9.0',
      codex: 'codex-cli 0.166.0' }, native: { platform: 'linux/arm64' } };
    for (const kind of ['agent', 'hooks']) {
      const calls = [];
      const io = managedResourceHost(async () => {}, {
        async docker(managed, args) {
          calls.push(args);
          assert.equal(managed, true);
          assert.deepEqual(args.slice(0, 5), ['exec', '--user=1000:1000', id,
            '/usr/local/bin/node', '-e']);
          return args.at(-1).includes('NIBFIN_TOOLS_VERIFIED')
            ? 'NIBFIN_TOOLS_VERIFIED\n' : 'NIBFIN_BROWSER_RUNTIME_VERIFIED\n';
        },
      });
      await io.availability(id, kind, inputs);
      assert.equal(calls.length, 2);
      assert.equal(calls[0].at(-1).includes("check('/usr/local/bin/codex'"),
        kind === 'agent');
      assert(calls[1].at(-1).includes('aarch64-linux-gnu'));
    }
  });

test('native and browser failures redact raw output at the host boundary', async () => {
  const inputs = { versions: { node: '24.22.1', go: '1.27.1', npm: '11.9.0',
    codex: 'codex-cli 0.166.0' }, native: { platform: 'linux/amd64' } };
  for (const phase of ['native', 'browser']) {
    const io = managedResourceHost(async () => {}, {
      async docker(managed, args) {
        if (phase === 'native' || args.at(-1).includes('NIBFIN_BROWSER_RUNTIME'))
          throw Error('sensitive provider exception');
        return 'NIBFIN_TOOLS_VERIFIED\n';
      },
    });
    const code = phase === 'native' ? 'RESOURCE_NATIVE_EXECUTABLE_UNAVAILABLE'
      : 'RESOURCE_BROWSER_INPUT_UNAVAILABLE';
    await assert.rejects(io.availability(id, 'agent', inputs), { code, message: code });
  }
});

test('managed Agent builds bind child inputs, target, versions and ownership',
  async () => {
    const recipe = await readFile(new URL(
      '../src/security/managed-agent.Dockerfile', import.meta.url), 'utf8');
    for (const arch of ['amd64', 'arm64']) {
      const reference = name => `docker.io/library/${name}@sha256:${id}`;
      const inputs = { 'managed-agent.Dockerfile': recipe,
        versions: { node: '24.22.1', go: '1.27.1', npm: '11.9.0',
          codex: 'codex-cli 0.166.0' },
        native: { platform: `linux/${arch}`,
          sources: { node: reference('node'), go: reference('golang') },
          images: { node: reference('node'), go: reference('golang') } },
      };
      const target = { owner: 'owned', inputs: digest(inputs), architecture: arch,
        images: {} };
      const name = 'nibfin-managed-resource:agent' +
        (arch === 'amd64' ? '' : '-arm64');
      let built = false, wrongPlatform = false;
      const io = managedResourceHost(async () => {}, {
        async docker(managed, args, options) {
          if (args[0] === 'build') {
            assert.equal(managed, true);
            assert.equal(args[args.indexOf('--platform') + 1], `linux/${arch}`);
            assert.equal(args[args.indexOf('--tag') + 1], name);
            assert(options.input.includes(`FROM ${inputs.native.images.go} AS go`));
            assert(options.input.includes(`FROM ${inputs.native.images.node}\n`));
            for (const value of ['CODEX_VERSION=0.166.0', 'GO_VERSION=1.27.1',
              'NPM_VERSION=11.9.0']) assert(options.input.includes(`ARG ${value}`));
            assert(!options.input.includes('nibfin-reviewed-'));
            built = true;
            return '';
          }
          if (args[1] === 'ls') return built ? image : '';
          return JSON.stringify([{ Id: image, Os: 'linux',
            Architecture: wrongPlatform ? 's390x' : arch,
            Config: { Labels: { [resources.label]: digest({
              owner: target.owner, inputs: target.inputs, kind: 'agent',
            }) } }, RepoTags: [name] }]);
        },
      });
      assert.equal(await io.image('agent', target, inputs, false), image);
      wrongPlatform = true;
      await assert.rejects(io.image('agent', target, inputs, true),
        { code: 'RESOURCE_IMAGE_CONFLICT' });
    }
  });
