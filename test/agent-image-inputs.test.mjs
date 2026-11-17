import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  agentSources, nativeManifest, resolveAgentInputs, resolvedAgentRecipe,
  prepareAgentInputs, agentVersions,
} from '../src/agent-image-inputs.mjs';

const recipe = await readFile(new URL('../src/security/agent.Dockerfile',
  import.meta.url), 'utf8');
const managed = await readFile(new URL('../src/security/managed-agent.Dockerfile',
  import.meta.url), 'utf8');
const manifest = architecture => ({
  digest: `sha256:${(architecture === 'amd64' ? 'a' : 'b').repeat(64)}`,
  mediaType: 'application/vnd.oci.image.manifest.v1+json', size: 123,
  platform: { os: 'linux', architecture },
});
const index = () => ({ schemaVersion: 2,
  mediaType: 'application/vnd.oci.image.index.v1+json',
  manifests: ['amd64', 'arm64'].map(manifest),
});

test('pinned source indexes select unique native immutable manifests', async () => {
  const sources = agentSources(recipe);
  for (const arch of ['amd64', 'arm64']) {
    const calls = [];
    const resolved = await resolveAgentInputs(recipe, arch, async source => {
      calls.push(source);
      return JSON.stringify(index());
    });
    assert.deepEqual(calls, Object.values(sources));
    assert.equal(resolved.platform, `linux/${arch}`);
    for (const name of ['node', 'go']) {
      assert.equal(resolved.images[name],
        `${sources[name].split('@')[0]}@${manifest(arch).digest}`);
    }
    const rendered = resolvedAgentRecipe(managed, resolved);
    assert(rendered.includes(`FROM ${resolved.images.node}\n`));
    assert(rendered.includes(`FROM ${resolved.images.go} AS go\n`));
    assert(!rendered.includes('nibfin-reviewed-'));
  }
});

test('incomplete, ambiguous and wrong-platform indexes cannot select a fallback', () => {
  for (const mutate of [
    value => { value.manifests.pop(); },
    value => { value.manifests.push(manifest('arm64')); },
    value => { value.manifests[1].platform.os = 'windows'; },
    value => { value.manifests[1].platform.variant = 'v9'; },
    value => { value.manifests[1].digest = 'moving:tag'; },
    value => { value.manifests[1].mediaType = value.mediaType; },
    value => { value.manifests[1].size = 0; },
    value => { value.schemaVersion = 1; },
  ]) {
    const value = index();
    mutate(value);
    assert.throws(() => nativeManifest(value, 'arm64'),
      error => error.code.startsWith('RESOURCE_INPUT_'));
  }
  assert.throws(() => nativeManifest(index(), 'riscv64'),
    { code: 'RESOURCE_INPUT_PLATFORM_UNSUPPORTED' });
  const value = index();
  value.manifests[1].platform.variant = 'v8';
  assert.equal(nativeManifest(value, 'arm64'), manifest('arm64').digest);
});

test('external resolution failures are bounded and never expose provider text',
  async () => {
    for (const inspect of [
      async () => { throw new Error('secret provider details'); },
      async () => 'bad json secret',
    ]) {
      await assert.rejects(resolveAgentInputs(recipe, 'amd64', inspect),
        { code: 'RESOURCE_INPUT_INDEX_UNAVAILABLE',
          message: 'RESOURCE_INPUT_INDEX_UNAVAILABLE' });
    }
    await assert.rejects(resolveAgentInputs(recipe, 'ppc64', () => {
      assert.fail('unsupported target must not contact a provider');
    }), { code: 'RESOURCE_INPUT_PLATFORM_UNSUPPORTED' });
  });

test('acquisition verifies selected source images before managed build effects',
  async () => {
    for (const arch of ['amd64', 'arm64']) {
      for (const fault of [null, 'pull', 'inspect', 'platform']) {
        const calls = [];
        const operation = prepareAgentInputs(recipe, arch, async args => {
          calls.push(args);
          if (args[0] === 'manifest') return JSON.stringify(index());
          if (args[0] === 'pull') {
            assert.equal(args[2], `linux/${arch}`);
            if (fault === 'pull') throw Error('private output');
            return '';
          }
          if (fault === 'inspect') return '{}';
          return JSON.stringify([{ Os: 'linux', Architecture:
            fault === 'platform' ? 's390x' : arch }]);
        });
        if (fault) await assert.rejects(operation,
          error => error.code.startsWith('RESOURCE_INPUT_'));
        else {
          const resolved = await operation;
          assert.equal(resolved.platform, `linux/${arch}`);
          assert.equal(calls.filter(args => args[0] === 'pull').length, 2);
        }
        assert(!calls.some(args => args[0] === 'build'));
      }
    }
  });

test('common versions come from existing maintained facts and must agree', async () => {
  const project = JSON.parse(await readFile(new URL('../package.json',
    import.meta.url)));
  const pkg = JSON.parse(await readFile(new URL(
    '../src/security/managed-npm/package.json', import.meta.url)));
  const versions = agentVersions(recipe, project, pkg);
  assert.equal(versions.node, project.engines.node);
  assert.equal(versions.codex, `codex-cli ${pkg.dependencies['@openai/codex']}`);
  const changed = structuredClone(pkg);
  changed.dependencies['@openai/codex'] = '0.0.1';
  assert.throws(() => agentVersions(recipe, project, changed),
    { code: 'RESOURCE_INPUT_CONTRACT_INVALID' });
});
