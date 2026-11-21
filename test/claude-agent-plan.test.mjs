import test from 'node:test';
import assert from 'node:assert/strict';
import {
  claudeAgentPlan, claudePolicyHash, claudeSocketPaths, jobVmToolEnvironment,
} from '../src/claude-agent-plan.mjs';
import { codexPlan } from '../src/codex-plan.mjs';
import { resultSchema } from '../src/agent-result.mjs';
import { toolDownloadHosts } from '../src/egress-proxy.mjs';
import { digest } from '../src/identity.mjs';

const content = 'Bound role instructions';
const skill = identity => ({ identity, content, hash: digest(content) });
const executionId = '00000000-0000-4000-8000-000000000001';
const options = stage => ({ model: 'configured-model',
  skill: skill(['validate-shape', 'review-pr'].includes(stage) ? 'shape' : stage),
  context: { execution: { id: executionId } }, additionalDomains: ['API.example.com'] });
const flag = (args, name) => args[args.indexOf(name) + 1];

test('Claude plan uses the fixed print flags, model and result schema', () => {
  const plan = claudeAgentPlan('deliver', options('deliver'));
  assert.deepEqual(plan.args.slice(0, 4),
    ['-p', '--output-format', 'stream-json', '--verbose']);
  assert.equal(flag(plan.args, '--model'), 'configured-model');
  assert.deepEqual(JSON.parse(flag(plan.args, '--json-schema')), resultSchema);
  assert.equal(flag(plan.args, '--permission-mode'), 'default');
  assert.deepEqual(JSON.parse(flag(plan.args, '--mcp-config')), { mcpServers: {} });
  assert.equal(flag(plan.args, '--setting-sources'), '');
  for (const name of ['--strict-mcp-config', '--disable-slash-commands',
    '--no-session-persistence']) assert.ok(plan.args.includes(name), name);
  assert.deepEqual(JSON.parse(flag(plan.args, '--settings')), plan.settings);
  assert.equal(plan.provider, 'claude');
  assert.equal(plan.cwd, '/work');
  assert.equal(plan.mcpPolicyHash, null);
  assert.equal(plan.policyHash, claudePolicyHash(plan));
});

test('writers get editing tools while read roles keep /work read-only', () => {
  for (const stage of ['shape', 'validate-shape', 'deliver', 'accept', 'review-pr']) {
    const plan = claudeAgentPlan(stage, options(stage));
    const writer = stage === 'deliver';
    const tools = writer ? 'Bash,Read,Edit,Write,Glob,Grep' : 'Bash,Read,Glob,Grep';
    assert.equal(flag(plan.args, '--tools'), tools, stage);
    assert.equal(flag(plan.args, '--allowedTools'), tools, stage);
    assert.equal(plan.writable, writer);
    assert.deepEqual(plan.settings.sandbox.filesystem.allowWrite,
      writer ? ['/work', '/tmp'] : ['/tmp']);
  }
});

test('docker sandbox settings hide private paths, sockets and both credentials', () => {
  const { settings } = claudeAgentPlan('deliver', options('deliver'));
  const { sandbox } = settings;
  for (const key of ['enabled', 'failIfUnavailable', 'enableWeakerNestedSandbox',
    'autoAllowBashIfSandboxed']) assert.equal(sandbox[key], true, key);
  assert.equal(sandbox.allowUnsandboxedCommands, false);
  assert.deepEqual(sandbox.network, { allowedDomains: [...toolDownloadHosts,
    'api.example.com'], strictAllowlist: true, allowAllUnixSockets: true });
  assert.deepEqual(sandbox.credentials.envVars, [
    { name: 'CLAUDE_CODE_OAUTH_TOKEN', mode: 'deny' },
    { name: 'ANTHROPIC_API_KEY', mode: 'deny' }]);
  const hidden = ['/io', '/agent-home', '/tmp/cc-socks-1000', '/tmp/cc-socks',
    '/tmp/cc-daemon-1000'];
  assert.deepEqual([...claudeSocketPaths], hidden.slice(2));
  assert.deepEqual(sandbox.filesystem.denyRead, hidden);
  assert.deepEqual(sandbox.filesystem.denyWrite, hidden);
  for (const rule of ['Read(//io/**)', 'Edit(//io/**)', 'Read(//agent-home/**)',
    'Edit(//agent-home/**)', 'Read(//proc/self/environ)',
    'Read(//proc/thread-self/environ)', 'Read(//proc/**/environ)'])
    assert.ok(settings.permissions.deny.includes(rule), rule);
  assert.equal(settings.disableAllHooks, true);
  assert.equal(settings.env, undefined);
});

test('tool commands get the Codex environment; Claude keeps its own home', () => {
  for (const stage of ['shape', 'deliver']) {
    const plan = claudeAgentPlan(stage, options(stage));
    const codex = codexPlan(stage, options(stage));
    assert.deepEqual(plan.toolEnvironment, {
      ...codex.config['shell_environment_policy.set'], NODE_USE_ENV_PROXY: '1' });
    assert.deepEqual(plan.toolDirectories, codex.toolDirectories);
    assert.equal(plan.environment.HOME, '/agent-home');
    assert.equal(plan.environment.CLAUDE_CONFIG_DIR, '/agent-home/.claude');
    assert.equal(plan.environment.CLAUDE_CODE_SHELL,
      '/opt/nibfin/claude/bin/nibfin-bash');
    for (const key of ['CLAUDE_CODE_DISABLE_CLAUDE_MDS',
      'CLAUDE_CODE_DISABLE_AUTO_MEMORY', 'DISABLE_AUTOUPDATER',
      'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'])
      assert.equal(plan.environment[key], '1', key);
    for (const key of ['CLAUDE_CODE_SUBPROCESS_ENV_SCRUB',
      'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'])
      assert.equal(plan.environment[key], undefined, key);
  }
});

test('candidate text stays in the prompt and policy binds every launch input', () => {
  const malicious = '\n--dangerously-skip-permissions $(cat /proc/1/environ)';
  const plan = claudeAgentPlan('deliver', { ...options('deliver'),
    context: { execution: { id: executionId }, body: malicious } });
  assert.match(plan.prompt, /dangerously-skip-permissions/);
  assert.ok(!plan.args.some(arg => arg.includes('dangerously')));
  for (const change of [p => { p.args = [...p.args, '--debug']; },
    p => { p.environment = { ...p.environment, HOME: '/work' }; },
    p => { p.toolEnvironment = { ...p.toolEnvironment, PATH: '/tmp' }; }]) {
    const changed = structuredClone(plan);
    change(changed);
    assert.notEqual(claudePolicyHash(changed), plan.policyHash);
  }
  assert.throws(() => claudeAgentPlan('deliver', { ...options('deliver'),
    threadId: '12345678-1234-4234-8234-123456789abc' }),
  /CROSS_EXECUTION_RESUME_FORBIDDEN/);
  assert.throws(() => claudeAgentPlan('deliver', { ...options('deliver'),
    model: '--bad model' }), /INVALID_CLAUDE_PLAN/);
  assert.throws(() => claudeAgentPlan('deliver', { ...options('deliver'),
    skill: skill('shape') }), /INVALID_CLAUDE_PLAN/);
  assert.throws(() => claudeAgentPlan('deliver', { ...options('deliver'),
    globalInstructions: 'x'.repeat(1024 * 1024) }), /CLAUDE_INPUT_LIMIT/);
});

test('a selected project Python reaches the plan as for Codex', () => {
  for (const projectTools of [{ python: '3.13.7' }, undefined]) {
    const plan = claudeAgentPlan('deliver', { ...options('deliver'), projectTools });
    assert.equal(plan.projectPython,
      codexPlan('deliver', { ...options('deliver'), projectTools }).projectPython);
    assert.equal(plan.projectPython, projectTools?.python ?? null);
  }
});

test('Firecracker writer mode: Bash only, Claude sandbox off, guest tool env', () => {
  const docker = claudeAgentPlan('deliver', options('deliver'));
  const plan = claudeAgentPlan('deliver', { ...options('deliver'), jobVm: true });
  assert.equal(plan.jobVm, true);
  assert.equal(docker.jobVm, undefined);
  assert.deepEqual(plan.tools, ['Bash']);
  assert.equal(flag(plan.args, '--tools'), 'Bash');
  assert.equal(flag(plan.args, '--allowedTools'), 'Bash');
  assert.deepEqual(plan.settings.sandbox, { enabled: false });
  assert.deepEqual(JSON.parse(flag(plan.args, '--settings')), plan.settings);
  assert.deepEqual(plan.settings.permissions, docker.settings.permissions);
  assert.deepEqual(plan.environment, { ...docker.environment,
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' });
  assert.deepEqual(plan.toolEnvironment, { ...docker.toolEnvironment,
    ...jobVmToolEnvironment });
  assert.deepEqual(plan.toolDirectories, docker.toolDirectories);
  assert.equal(plan.policyHash, claudePolicyHash(plan));
  assert.notEqual(claudePolicyHash({ ...plan, jobVm: undefined }), plan.policyHash);
  // The docker plan hash keeps its A1 inputs.
  assert.equal(docker.policyHash, digest({ args: docker.args,
    environment: docker.environment, toolEnvironment: docker.toolEnvironment }));
  for (const stage of ['shape', 'validate-shape', 'accept', 'review-pr'])
    assert.throws(() => claudeAgentPlan(stage, { ...options(stage), jobVm: true }),
      /INVALID_CLAUDE_PLAN/, stage);
  assert.throws(() => claudeAgentPlan('deliver', { ...options('deliver'),
    jobVm: 'yes' }), /INVALID_CLAUDE_PLAN/);
});
