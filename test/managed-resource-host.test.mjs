import assert from 'node:assert/strict';
import { test } from 'node:test';
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
