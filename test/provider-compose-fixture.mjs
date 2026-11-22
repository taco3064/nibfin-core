import { mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Composition only: every collaborator records its constructor/call arguments.
let calls;
const reset = () => { calls = { role: [], environment: [], mcp: [], vm: [] }; };
const source = await import('../src/source-package.mjs');
mock.module('../src/source-package.mjs', { namedExports: {
  ...source, verifyInstalledSource: async () => {},
} });
mock.module('../src/codex-agent.mjs', { namedExports: {
  CodexRoleAgent: class {
    constructor(...args) { calls.role.push(args); }
  },
} });
mock.module('../src/codex-environment.mjs', { namedExports: {
  codexEnvironment: async (...args) => {
    calls.environment.push(args);
    return { agent: { execute: async () => 'docker' }, hooks: {}, image: 'tools' };
  },
} });
mock.module('../src/mcp-agent.mjs', { namedExports: {
  withUserMcp: (agent, ...rest) => { calls.mcp.push(rest); return agent; },
} });
mock.module('../src/job-vm-writer.mjs', { namedExports: {
  runJobVmWriter: async (...args) => { calls.vm.push(args); return 'vm'; },
} });
mock.module('../src/workspace.mjs', { namedExports: {
  CandidateWorkspace: class {
    constructor(directory) { this.work = join(directory, 'work'); }
  },
} });
mock.module('../src/installed-stage.mjs', { namedExports: {
  installedStageExecutor: options => options,
} });
const { codexStageExecutor } = await import('../src/codex-stage.mjs');

const root = await mkdtemp(join(tmpdir(), 'nibfin-provider-compose-'));
try {
  for (const name of ['shape', 'deliver', 'accept']) {
    await mkdir(join(root, 'skills', name), { recursive: true });
    await writeFile(join(root, 'skills', name, 'SKILL.md'), 'builtin');
  }
  await mkdir(join(root, 'src', 'security'), { recursive: true });
  await writeFile(join(root, 'src', 'security', 'job-vm-executor.py'), 'executor');
  const issue = { id: 'I_target', number: 1, repository: 'owner/target',
    repositoryId: 2 };
  const runner = { repository: 'owner/execution', repositoryId: 1, memberId: 4,
    target: issue };
  const base = (role, extra = {}) => ({
    installation: { directory: root }, config: { runner, stateRoot: '/receipts',
      approval: { issueId: issue.id } }, isolation: { issue, agent: {} },
    execution: { role, id: 'execution' }, workspaceRoot: join(root, 'workspace'),
    agentStateRoot: '/agent', authFile: '/private/codex', model: 'fixture-model',
    project: {}, toolEnvironment: 'job-tools', inspectWriter: async () => {},
    token: 'fixture-token', ...extra,
  });
  const jobVm = { stateRoot: '/vm' };
  const claude = { provider: 'claude', credentialKind: 'claude-subscription-token' };

  // Codex golden: the composition arguments existing before Claude was added.
  reset();
  await codexStageExecutor(base('writer', { jobVm, mcpSource: { servers: {} } }));
  const [config, , options] = calls.role[0];
  assert.deepEqual(Object.keys(config), ['stateRoot', 'reportRoot', 'authFile',
    'model', 'proposal', 'globalInstructions', 'skills', 'coreRoot', 'work',
    'project', 'projectRoot']);
  assert.equal(config.authFile, '/private/codex');
  assert.deepEqual(Object.keys(options), ['settlement', 'upstream']);
  assert.deepEqual(calls.environment[0].slice(3), [{},
    { toolEnvironment: 'job-tools' }]);
  assert.equal(calls.mcp.length, 1);
  assert.deepEqual(calls.mcp[0][0], { servers: {} });
  assert.equal(await calls.role[0][1].execute({ plan: {} }), 'vm');
  assert.equal(calls.vm[0].length, 3);

  // Claude docker: provider, no login file, no user MCP, bound credential reader.
  reset();
  await codexStageExecutor(base('writer', claude));
  const [docker, agent, dockerOptions] = calls.role[0];
  assert.equal(docker.provider, 'claude');
  assert.equal(docker.jobVm, false);
  assert.equal(Object.hasOwn(docker, 'authFile'), false);
  assert.equal(typeof dockerOptions.readCredential, 'function');
  assert.deepEqual(calls.environment[0][4],
    { toolEnvironment: 'job-tools', provider: 'claude' });
  assert.equal(calls.mcp.length, 0);
  assert.equal(await agent.execute({}), 'docker');

  // Claude Firecracker writer selects the Claude guest route and VM-mode plan.
  reset();
  await codexStageExecutor(base('writer', { ...claude, jobVm }));
  assert.equal(calls.role[0][0].jobVm, true);
  assert.equal(await calls.role[0][1].execute({ plan: {} }), 'vm');
  assert.equal(calls.vm[0].length, 4);
  assert.deepEqual(calls.vm[0][3], { provider: 'claude' });

  // A reviewer or validator on a Firecracker host stays on its docker sandbox.
  for (const role of ['reviewer', 'validator', 'author']) {
    reset();
    await codexStageExecutor(base(role, { ...claude, jobVm }));
    assert.equal(calls.role[0][0].jobVm, false);
    assert.equal(await calls.role[0][1].execute({}), 'docker');
    assert.equal(calls.vm.length, 0);
  }

  // Unsupported Claude paths fail closed before any collaborator is composed.
  for (const [extra, code] of [
    [{ mcpSource: { servers: {} } }, 'CLAUDE_MCP_UNSUPPORTED'],
    [{ mcpJob: { read: async () => ({}) } }, 'CLAUDE_MCP_UNSUPPORTED'],
    [{ credentialKind: 'codex-chatgpt' }, 'PROVIDER_CREDENTIAL_KIND_INVALID'],
    [{ credentialKind: undefined }, 'PROVIDER_CREDENTIAL_KIND_INVALID'],
    [{ provider: 'codex' }, 'PROVIDER_COMPOSITION_UNAVAILABLE'],
  ]) {
    reset();
    await assert.rejects(codexStageExecutor(base('writer', { ...claude, ...extra })),
      { code });
    assert.equal(calls.environment.length + calls.role.length, 0);
  }
  console.log('Provider composition passed.');
} finally {
  mock.restoreAll();
  await rm(root, { recursive: true, force: true });
}
