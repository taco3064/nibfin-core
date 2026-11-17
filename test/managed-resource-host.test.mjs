import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { digest } from '../src/identity.mjs';
import { managedResourceHost } from '../src/managed-resource-host.mjs';
import { managedResources as resources } from '../src/managed-resource-contract.mjs';

const id = 'a'.repeat(64);
const image = `sha256:${id}`;
const state = { owner: 'owned', inputs: 'fixed', images: { agent: image } };
const inputs = { 'managed-hook.Dockerfile': 'FROM nibfin-managed-agent-input\n' };

test('build binds Hook recipe to inspected Agent ID and refuses unknown effects',
  async () => {
    let exists = false;
    let builds = 0;
    const io = managedResourceHost(async () => {}, {
      async docker(managed, args, options) {
        assert.equal(managed, true);
        if (args[0] === 'build') {
          builds++;
          assert.equal(options.input, `FROM ${image}\n`);
          assert(args.includes('--no-cache'));
          assert(args.includes('--network=host'));
          exists = true;
          throw new Error('Reply lost after successful build');
        }
        if (args[1] === 'ls') return exists ? image : '';
        assert.equal(args[1], 'inspect');
        return JSON.stringify([{ Id: image, Os: 'linux', Architecture: 'amd64',
          Config: { Labels: { [resources.label]: digest({
            owner: state.owner, inputs: state.inputs, kind: 'hooks',
          }) } }, RepoTags: ['nibfin-managed-resource:hooks'] }]);
      },
    });
    assert.equal(await io.image('hooks', state, inputs, false), image);
    assert.equal(await io.image('hooks', state, inputs, true), image);
    assert.equal(builds, 1);
    exists = false;
    await assert.rejects(io.image('hooks', state, inputs, true),
      { code: 'RESOURCE_IMAGE_RECONCILIATION_REQUIRED' });
    assert.equal(builds, 1);
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
  const io = managedResourceHost(async () => {}, {
    async docker(managed, args) {
      if (args[1] === 'ls') return image;
      return JSON.stringify([{ Id: image, Os: 'linux', Architecture: 'amd64',
        Config: { Labels: {} }, RepoTags: ['nibfin-managed-resource:hooks'] }]);
    },
  });
  await assert.rejects(io.image('hooks', state, inputs, true),
    { code: 'RESOURCE_IMAGE_CONFLICT' });
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
