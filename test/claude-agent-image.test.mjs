import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import {
  readFile, access, mkdtemp, mkdir, rm, writeFile,
} from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { digest } from '../src/identity.mjs';
import { managedResourceHost } from '../src/managed-resource-host.mjs';
import { managedResources as resources } from '../src/managed-resource-contract.mjs';
import {
  agentVersions, claudePackageVersion, resolvedClaudeRecipe,
} from '../src/agent-image-inputs.mjs';
import {
  preparationRecipe, toolProbe, versionProbe,
} from '../src/tool-recipe.mjs';
import { derivedBaseInput } from '../src/managed-derived-image.mjs';
import { claudeToolShell, claudeVersionPattern } from '../src/claude-agent-plan.mjs';
import { claudeModelComponent } from '../src/claude-model-runner.mjs';

const security = new URL('../src/security/', import.meta.url);
const source = name => readFile(new URL(name, security), 'utf8');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const id = 'a'.repeat(64);
const agentImage = `sha256:${id}`;
const claudeImage = `sha256:${'c'.repeat(64)}`;
const pin = '2.1.326 (Claude Code)';
const sourceCheckStart = 'RUN list=/etc/apt/sources.list && . /etc/os-release';

// Golden values computed from origin/main (f9f60e1) before the Claude image kind.
const codexInputKeys = ['managed-agent.Dockerfile', 'managed-hook.Dockerfile',
  'package.json', 'package-lock.json', 'agent.Dockerfile', 'core-package.json',
  'versions', 'native', 'policy'];
const goldenVersions = { node: '24.22.1', go: '1.27.1', npm: '11.9.0',
  codex: 'codex-cli 0.166.0' };
const goldenProbes = {
  agent: 'a45a7bea12bfb127ff08af0e495b0376b763e8f3e87756de8fc20cbe3b1a1f16',
  hooks: 'a822e2b8106e5381470f4556f9e38401ec7e53c34da7799e5ea1de830b72fe35',
  tool: 'a3ce1b52a20c5a4a02670172931af1b4016005068ae40ece369394c07c8e587e',
};
const tools = { node: '22.15.0', python: '3.13.7', go: '1.27.1' };

function inputEngine() {
  const record = (digit, architecture, variant) => ({ digest: `sha256:${
    digit.repeat(64)}`, size: 1,
  mediaType: 'application/vnd.oci.image.manifest.v1+json',
  platform: { os: 'linux', architecture, ...(variant ? { variant } : {}) } });
  return { async docker(managed, args) {
    assert.equal(managed, true);
    assert.notEqual(args[0], 'build');
    if (args[0] === 'manifest') return JSON.stringify({ schemaVersion: 2,
      mediaType: 'application/vnd.oci.image.index.v1+json',
      manifests: [record('1', 'amd64'), record('2', 'arm64', 'v8')] });
    if (args[0] === 'pull') return '';
    return JSON.stringify([{ Os: 'linux', Architecture: 'amd64' }]);
  } };
}

test('the Claude recipe derives from the prepared Agent image and adds only the ' +
  'sandbox packages, the verified CLI and the tool shell', async () => {
  const recipe = await source(resources.claude.recipe);
  assert.deepEqual(recipe.match(/^FROM .*$/gm), ['FROM nibfin-managed-agent-input']);
  assert.match(recipe, /^RUN rm \/usr\/local\/bin\/codex$/m);
  assert.match(recipe, /apt-get install -y --no-install-recommends bubblewrap socat/);
  // The source check runs in its own layer before apt-get update.
  assert(recipe.indexOf(sourceCheckStart) < recipe.indexOf('RUN apt-get update'));
  assert.doesNotMatch(recipe, /sources\.list\s*>|deb\.debian\.org|curl|wget|npm i/);
  assert.match(recipe, /^ARG CLAUDE_VERSION$/m);
  assert.match(recipe, /^COPY claude-package\.mjs \/opt\/nibfin\/claude\/install\.mjs$/m);
  assert.match(recipe, /^RUN node \/opt\/nibfin\/claude\/install\.mjs && rm /m);
  assert.match(recipe, new RegExp(`^COPY --chmod=0755 nibfin-bash ${claudeToolShell}$`,
    'm'));
  for (const path of ['/etc/claude-code', '/root/.claude', '/home/node/.claude',
    '/.claude', '/CLAUDE.md', '/CLAUDE.local.md', '/work/.claude', '/work/CLAUDE.md',
    '/work/CLAUDE.local.md', '/usr/local/bin/codex'])
    assert(recipe.includes(`test ! -e ${path} `) ||
      recipe.includes(`test ! -e ${path}\n`), path);
  for (const label of ['io.nibfin.claude-version="${CLAUDE_VERSION}"',
    'io.nibfin.claude-managed-settings="absent"',
    'io.nibfin.resource-kind="claude-agent"'])
    assert(recipe.includes(`\nLABEL ${label}\n`), label);
  // The managed build context is src/security: every COPY source is maintained there.
  for (const [, from] of recipe.matchAll(/^COPY (?:--chmod=\d+ )?(\S+) /gm))
    await access(new URL(from, security));
  assert.deepEqual([resources.claude.package, resources.claude.shell],
    ['claude-package.mjs', 'nibfin-bash']);
  for (const line of recipe.split('\n')) assert(line.length <= 90, line);
});

// The recipe's sources.list check as one shell command, pointed at fixtures.
function sourceCheck(recipe, root) {
  const start = recipe.indexOf(sourceCheckStart);
  const end = recipe.indexOf('\n# ', start);
  assert(start > 0 && end > start && !root.includes("'"));
  return recipe.slice(start + 'RUN '.length, end).replace(/ \\\n/g, ' ')
    .replace('list=/etc/apt/sources.list', `list='${root}/sources.list'`)
    .replace('/etc/os-release', `'${root}/os-release'`)
    .replace('/etc/apt/sources.list.d', `'${root}/sources.list.d'`);
}

test('apt sources must be exactly the Agent snapshot main and security lines',
  async () => {
    const recipe = await source(resources.claude.recipe);
    const agent = await source('managed-agent.Dockerfile');
    assert.match(agent, /printf 'deb \[check-valid-until=no\] %s %s main\\n'/);
    // The Agent recipe writes main then security, with one shared timestamp.
    const urls = [...agent.matchAll(/^\s+(http:\/\/snapshot\.debian\.org\/\S+) \\$/gm)]
      .map(match => match[1]);
    assert.equal(urls.length, 2);
    assert.match(urls[0], /\/archive\/debian\/\d{8}T\d{6}Z\/$/);
    assert.equal(urls[1], urls[0].replace('/debian/', '/debian-security/'));
    const deb = (url, suite) => `deb [check-valid-until=no] ${url} ${suite} main\n`;
    const good = deb(urls[0], 'bookworm') + deb(urls[1], 'bookworm-security');
    const other = '20260101T000000Z';
    const root = await mkdtemp(join(tmpdir(), 'nibfin-claude-sources-'));
    try {
      const check = sourceCheck(recipe, root);
      const run = async (list, { codename = 'bookworm', extra } = {}) => {
        await rm(join(root, 'sources.list.d'), { recursive: true, force: true });
        await mkdir(join(root, 'sources.list.d'));
        if (extra) await writeFile(join(root, 'sources.list.d', extra), good);
        await writeFile(join(root, 'sources.list'), list);
        await writeFile(join(root, 'os-release'), `VERSION_CODENAME=${codename}\n`);
        return spawnSync('sh', ['-c', check]).status;
      };
      assert.equal(await run(good), 0);
      for (const [list, options] of [
        [deb(urls[0], 'bookworm')], [deb(urls[1], 'bookworm-security')],
        [deb(urls[1], 'bookworm-security') + deb(urls[0], 'bookworm')],
        [deb(urls[0], 'bookworm') + deb(urls[1].replace(/\d{8}T\d{6}Z/, other),
          'bookworm-security')],
        [good + 'deb http://deb.debian.org/debian bookworm main\n'],
        [good + '\n'], [good.replace(/main\n$/, 'main contrib\n')],
        [good.replaceAll('http:', 'https:')], [good.slice(0, -1)], [''],
        [good, { codename: 'trixie' }], [good, { codename: '' }],
        [good, { extra: 'debian.sources' }]])
        assert.notEqual(await run(list, options), 0, JSON.stringify([list, options]));
    } finally { await rm(root, { recursive: true, force: true }); }
  });

test('the CLI pin comes from the verified package script', async () => {
  const script = await source('claude-package.mjs');
  assert.equal(claudePackageVersion(script), pin);
  assert.match(pin, claudeVersionPattern);
  assert.equal(`${claudeModelComponent.cli.version} (Claude Code)`, pin);
  for (const changed of ['', script.replace("const version = '2.1.326';",
    "const version = 'latest';")])
    assert.throws(() => claudePackageVersion(changed),
      { code: 'RESOURCE_INPUT_CONTRACT_INVALID' });
  const recipe = await source(resources.claude.recipe);
  const resolved = resolvedClaudeRecipe(recipe, pin);
  // Only the version is pinned; the base input is left for derivedRecipe.
  assert.equal(resolved, recipe.replace('\nARG CLAUDE_VERSION\n',
    '\nARG CLAUDE_VERSION=2.1.326\n'));
  assert(resolved.includes(`\nFROM ${derivedBaseInput}\n`));
  for (const [value, version] of [[recipe, '2.1.326'], [recipe, undefined],
    [`${recipe}FROM ${derivedBaseInput}\n`, pin],
    [recipe.replace(derivedBaseInput, agentImage), pin],
    [recipe.replace('ARG CLAUDE_VERSION\n', ''), pin], [undefined, pin]])
    assert.throws(() => resolvedClaudeRecipe(value, version),
      { code: 'RESOURCE_INPUT_CONTRACT_INVALID' });
});

test('Codex Agent and Hook probes and tool recipes are unchanged (golden)',
  async () => {
    assert.equal(sha256(versionProbe({ go: goldenVersions.go }, goldenVersions,
      { codex: true, npm: goldenVersions.npm })), goldenProbes.agent);
    assert.equal(sha256(versionProbe({ go: goldenVersions.go }, goldenVersions,
      { codex: false, npm: goldenVersions.npm })), goldenProbes.hooks);
    const codex = { node: '24.22.1', codex: 'codex-cli 0.166.0' };
    assert.equal(sha256(versionProbe(tools, codex)), goldenProbes.tool);
    assert.equal(sha256(toolProbe(tools, codex)), goldenProbes.tool);
    const pkg = JSON.parse(await readFile(new URL('../package.json',
      import.meta.url)));
    const maintained = await source('agent.Dockerfile');
    const version = /^ARG CODEX_VERSION=(\S+)$/m.exec(maintained)[1];
    for (const arch of ['x64', 'arm64']) {
      const recipe = await preparationRecipe(tools, agentImage, arch);
      assert.deepEqual(await preparationRecipe(tools, agentImage, arch,
        { provider: 'codex' }), recipe);
      assert.deepEqual(recipe.versions,
        { node: pkg.engines.node, codex: `codex-cli ${version}` });
      const lines = recipe.dockerfile.split('\n').slice(0, -2);
      assert.equal(recipe.key, digest({ recipe: lines, wrappers: recipe.wrappers,
        platform: recipe.platform, tools, versions: recipe.versions,
        probe: versionProbe(tools, recipe.versions) }));
    }
  });

test('Codex inputs are unchanged; a Claude request adds its pinned inputs', async () => {
  const io = managedResourceHost(async () => {}, inputEngine());
  const codex = await io.inputs('amd64');
  assert.deepEqual(Object.keys(codex), codexInputKeys);
  assert.deepEqual(Object.keys(codex.versions), ['node', 'codex', 'go', 'npm']);
  assert.deepEqual(await io.inputs('amd64', { claude: false }), codex);
  const claude = await io.inputs('amd64', { claude: true });
  for (const key of codexInputKeys.filter(key => key !== 'versions'))
    assert.deepEqual(claude[key], codex[key], key);
  assert.deepEqual(claude.versions, { ...codex.versions, claude: pin });
  assert.deepEqual(Object.keys(claude).filter(key => !codexInputKeys.includes(key)),
    [resources.claude.recipe, resources.claude.package, resources.claude.shell]);
  for (const name of [resources.claude.recipe, resources.claude.package,
    resources.claude.shell])
    assert.equal(claude[name], await source(name));
  assert.notEqual(digest(claude), digest(codex));
  // The pin and package script are hashed into the image identity.
  const script = claude[resources.claude.package];
  const moved = { ...claude, [resources.claude.package]:
    script.replace("'2.1.326'", "'2.1.327'"),
  versions: { ...claude.versions, claude: '2.1.327 (Claude Code)' } };
  assert.notEqual(digest(moved), digest(claude));
  const marker = inputs => digest({ owner: 'owned', inputs: digest(inputs),
    kind: resources.claude.kind });
  assert.notEqual(marker(moved), marker(claude));
});

test('the Claude Agent image builds FROM the managed Agent tag with the pin and ' +
  'sits on the prepared Agent layers', async () => {
  const recipe = await source(resources.claude.recipe);
  const inputs = { [resources.claude.recipe]: recipe,
    versions: { ...goldenVersions, claude: pin } };
  const state = { owner: 'owned', inputs: 'fixed', architecture: 'arm64',
    images: { agent: agentImage, hooks: `sha256:${'b'.repeat(64)}` } };
  const name = 'nibfin-managed-resource:claude-agent-arm64';
  const base = 'nibfin-managed-resource:agent-arm64';
  const expected = resolvedClaudeRecipe(recipe, pin)
    .replace(derivedBaseInput, base);
  let built = 0;
  let tagged = agentImage;
  let layers = ['sha256:l1', 'sha256:l2', 'sha256:l3'];
  const io = managedResourceHost(async () => {}, {
    async docker(managed, args, options) {
      assert.equal(managed, true);
      if (args[0] === 'build') {
        built++;
        assert.equal(args[args.indexOf('--platform') + 1], 'linux/arm64');
        assert.equal(args[args.indexOf('--tag') + 1], name);
        assert(args.at(-1).endsWith('/src/security'));
        assert.equal(options.input, expected);
        assert(!options.input.includes(agentImage));
        return '';
      }
      if (args[1] === 'ls') return built ? claudeImage : '';
      assert.deepEqual(args.slice(0, 2), ['image', 'inspect']);
      if (args[2] === base) return JSON.stringify([{ Id: tagged }]);
      if (args[2] === agentImage)
        return JSON.stringify([{ Id: agentImage, RootFS: { Layers: ['sha256:l1',
          'sha256:l2'] } }]);
      assert.equal(args[2], claudeImage);
      return JSON.stringify([{ Id: claudeImage, Os: 'linux',
        Architecture: 'arm64', RepoTags: [name], RootFS: { Layers: layers },
        Config: { Labels: { [resources.label]: digest({ owner: 'owned',
          inputs: 'fixed', kind: 'claude-agent' }) } } }]);
    },
  });
  assert.equal(await io.image('claude-agent', state, inputs, false), claudeImage);
  assert.equal(await io.image('claude-agent', state, inputs, true), claudeImage);
  assert.equal(built, 1);
  // An image off the prepared Agent layers is a conflict, even when observed.
  layers = ['sha256:other', 'sha256:l2', 'sha256:l3'];
  await assert.rejects(io.image('claude-agent', state, inputs, true),
    { code: 'RESOURCE_IMAGE_CONFLICT' });
  built = 0;
  await assert.rejects(io.image('claude-agent', state,
    { ...inputs, versions: goldenVersions }, false),
  { code: 'RESOURCE_INPUT_CONTRACT_INVALID' });
  // The managed Agent tag must still name the prepared ID before any build.
  tagged = `sha256:${'d'.repeat(64)}`;
  await assert.rejects(io.image('claude-agent', state, inputs, false),
    { code: 'RESOURCE_IMAGE_CONFLICT' });
  assert.equal(built, 0);
});

test('Claude availability checks its CLI and sandbox tools, never Codex',
  async () => {
    const calls = [];
    const io = managedResourceHost(async () => {}, {
      async docker(managed, args) {
        calls.push(args);
        return args.at(-1).includes('NIBFIN_TOOLS_VERIFIED')
          ? 'NIBFIN_TOOLS_VERIFIED\n' : 'NIBFIN_BROWSER_RUNTIME_VERIFIED\n';
      },
    });
    const inputs = { versions: { ...goldenVersions, claude: pin },
      native: { platform: 'linux/amd64' } };
    await io.availability(id, 'claude-agent', inputs);
    assert.equal(calls.length, 2);
    const probe = calls[0].at(-1);
    assert(!probe.includes("check('/usr/local/bin/codex'"));
    for (const check of ["check(\"/opt/nibfin/claude/bin/claude\", ['--version'],\n" +
      `  ${JSON.stringify(pin)}, fixed);`, "check('/usr/bin/bwrap', ['--version']",
    "check('/usr/bin/socat', ['-V']", "check('/usr/local/bin/npm'"])
      assert(probe.includes(check), check);
    for (const kind of ['agent', 'hooks']) {
      calls.length = 0;
      await io.availability(id, kind, inputs);
      assert(!calls[0].at(-1).includes('claude'));
    }
    calls.length = 0;
    await assert.rejects(io.availability(id, 'claude-agent',
      { ...inputs, versions: goldenVersions }),
    { code: 'RESOURCE_INPUT_CONTRACT_INVALID' });
    assert.equal(calls.length, 0);
  });

function executeProbe(probe, answers) {
  const calls = [];
  let output = '';
  runInNewContext(probe, {
    require: () => ({ execFileSync(file, args) {
      calls.push(file);
      if (!(file in answers)) return '';
      return answers[file];
    } }),
    process: { stdout: { write: value => { output += value; } } },
  });
  return { calls, output };
}

test('project tool images on a Claude base check the Claude CLI', async () => {
  const claude = await preparationRecipe(tools, agentImage, 'x64',
    { provider: 'claude' });
  const codex = await preparationRecipe(tools, agentImage, 'x64');
  assert.deepEqual(claude.versions, { node: codex.versions.node, claude: pin });
  assert.equal(claude.dockerfile.replace(/tool-environment="[a-f0-9]+"/, ''),
    codex.dockerfile.replace(/tool-environment="[a-f0-9]+"/, ''));
  assert.notEqual(claude.key, codex.key);
  const probe = toolProbe(tools, claude.versions);
  assert.equal(claude.key, digest({ recipe: claude.dockerfile.split('\n').slice(0, -2),
    wrappers: claude.wrappers, platform: claude.platform, tools,
    versions: claude.versions, probe }));
  const answers = { '/usr/local/bin/node': 'v24.22.1\n',
    '/opt/nibfin/claude/bin/claude': `${pin}\n`, node: 'v22.15.0\n',
    python3: 'Python 3.13.7\n', go: 'go1.27.1\n', gofmt: 'package probe' };
  const { calls, output } = executeProbe(probe, answers);
  assert.equal(output, 'NIBFIN_TOOLS_VERIFIED\n');
  assert(!calls.includes('/usr/local/bin/codex'));
  for (const file of ['/opt/nibfin/claude/bin/claude', '/usr/bin/bwrap',
    '/usr/bin/socat']) assert(calls.includes(file), file);
  assert.throws(() => executeProbe(probe, { ...answers,
    '/opt/nibfin/claude/bin/claude': '2.1.1 (Claude Code)\n' }),
  /NIBFIN_TOOL_PROBE_CLAUDE_VERSION_MISMATCH/);
  await assert.rejects(preparationRecipe(tools, agentImage, 'x64',
    { provider: 'other' }), { code: 'INVALID_TOOL_PROVIDER' });
  assert.equal(agentVersions(await source('agent.Dockerfile'),
    { engines: { node: '24.22.1' } }, JSON.parse(await readFile(new URL(
      'managed-npm/package.json', security), 'utf8')),
    await source('claude-package.mjs')).claude, pin);
});
