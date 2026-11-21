import { privatePlanContract, validProviderModel } from './provider-contract.mjs';
import { digest, requireThat } from './identity.mjs';
import { resultSchema } from './agent-result.mjs';
import { skillIdentity } from './skills.mjs';
import { toolDownloadHosts, projectDomains } from './egress-proxy.mjs';
import { rolePrompt } from './role-prompt.mjs';
import { projectToolEnvironment } from './codex-plan.mjs';
import { projectToolDirectories, projectToolRoot } from './project-tool-paths.mjs';
import { claudeLimits } from './claude-plan.mjs';

// Image contract of the Claude agent container (installed by the image recipe).
export const claudeToolShell = '/opt/nibfin/claude/bin/nibfin-bash';
// Claude only: the Codex profile plus environ denies for every process.
export const claudeAppArmorProfile = 'nibfin-claude-container';
// `claude --version` output of the bound CLI, for example "2.1.326 (Claude Code)".
export const claudeVersionPattern = /^\d+\.\d+\.\d+ \(Claude Code\)$/;
// Both credential kinds; the bootstrap places exactly one in Claude's own env.
export const claudeTokenVariables = Object.freeze([
  'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY',
]);
// Claude's own socket directories stay out of reach of sandboxed tools.
export const claudeSocketPaths = Object.freeze([
  '/tmp/cc-socks-1000', '/tmp/cc-socks', '/tmp/cc-daemon-1000',
]);

// Firecracker writer: the guest owns the writable /work; local Read/Edit/Write
// would touch the stale read-only copy, so only Bash reaches the guest shell.
export function claudeAgentTools(writable, jobVm = false) {
  if (jobVm) return ['Bash'];
  return writable ? ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep'] :
    ['Bash', 'Read', 'Glob', 'Grep'];
}

// Copy of the guest tool settings forwardJobVmArguments gives Codex in VM mode;
// test/claude-vm-shell.test.mjs pins them equal.
export const jobVmToolEnvironment = Object.freeze({
  NO_PROXY: '127.0.0.1,localhost', HTTP_PROXY: 'http://127.0.0.1:3128',
  HTTPS_PROXY: 'http://127.0.0.1:3128', NODE_USE_ENV_PROXY: '1',
  DOCKER_HOST: 'tcp://127.0.0.1:2375',
});

export const claudePolicyHash = plan => digest({ args: plan.args,
  environment: plan.environment, toolEnvironment: plan.toolEnvironment,
  ...(plan.jobVm === true ? { jobVm: true } : {}) });

// Docker writer mode: Claude's bubblewrap sandbox is the inner tool isolation.
// Firecracker writer mode (jobVm): the VM is the isolation; Claude's sandbox is
// off and nibfin-bash forwards every tool script to the Core guest shell.
// Every value is a distinct argv element; candidate text reaches only the prompt.
export function claudeAgentPlan(stage, {
  model, threadId = null, skill, context, hasProposal = false,
  globalInstructions, additionalDomains, projectTools, jobVm = false,
}) {
  requireThat(validProviderModel(model) &&
    skill?.identity === skillIdentity(stage) && typeof skill.content === 'string' &&
    digest(skill.content) === skill.hash, 'INVALID_CLAUDE_PLAN');
  requireThat(threadId === null, 'CROSS_EXECUTION_RESUME_FORBIDDEN');
  const selectedDomains = projectDomains(additionalDomains);
  const contract = privatePlanContract(stage, { model });
  const writable = contract.capabilities.workspace === 'write';
  requireThat(typeof jobVm === 'boolean' && (!jobVm || writable),
    'INVALID_CLAUDE_PLAN');
  const executionId = context.execution?.id;
  const hidden = ['/io', '/agent-home', ...claudeSocketPaths];
  const settings = {
    disableAllHooks: true, enabledPlugins: {},
    sandbox: jobVm ? { enabled: false } : {
      enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false,
      enableWeakerNestedSandbox: true, autoAllowBashIfSandboxed: true,
      network: {
        allowedDomains: [...new Set([...toolDownloadHosts, ...selectedDomains])],
        strictAllowlist: true, allowAllUnixSockets: true,
      },
      credentials: {
        envVars: claudeTokenVariables.map(name => ({ name, mode: 'deny' })),
      },
      filesystem: {
        allowWrite: [...(writable ? ['/work'] : []), '/tmp'],
        denyRead: hidden, denyWrite: hidden,
      },
    },
    permissions: {
      deny: ['Read(//io/**)', 'Edit(//io/**)', 'Read(//agent-home/**)',
        'Edit(//agent-home/**)', 'Read(//proc/self/environ)',
        'Read(//proc/thread-self/environ)', 'Read(//proc/**/environ)'],
    },
  };
  const tools = claudeAgentTools(writable, jobVm).join(',');
  const args = [
    '-p', '--output-format', 'stream-json', '--verbose',
    '--model', model, '--json-schema', JSON.stringify(resultSchema),
    '--permission-mode', 'default', '--tools', tools, '--allowedTools', tools,
    '--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers: {} }),
    '--setting-sources', '', '--disable-slash-commands', '--no-session-persistence',
    '--settings', JSON.stringify(settings),
  ];
  const prompt = rolePrompt(stage, { skill, context, hasProposal,
    globalInstructions, projectTools });
  requireThat(Buffer.byteLength(prompt) <= claudeLimits.stdin, 'CLAUDE_INPUT_LIMIT');
  const plan = {
    provider: 'claude', contract, additionalDomains: selectedDomains,
    args, settings, tools: claudeAgentTools(writable, jobVm), schema: resultSchema,
    prompt,
    expectedThread: threadId, writable, mcpPolicyHash: null,
    toolDirectories: projectToolDirectories(writable, executionId),
    toolRoot: projectToolRoot(writable, executionId),
    projectPython: projectTools?.python ?? null,
    // Applied by nibfin-bash to tool commands, never to Claude itself.
    toolEnvironment: { ...projectToolEnvironment(writable, executionId),
      NODE_USE_ENV_PROXY: '1', ...(jobVm ? jobVmToolEnvironment : {}) },
    cwd: '/work',
    environment: {
      HOME: '/agent-home', CLAUDE_CONFIG_DIR: '/agent-home/.claude',
      PATH: '/usr/local/bin:/usr/bin:/bin', CLAUDE_CODE_SHELL: claudeToolShell,
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
      DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      // A guest command must end with its tool call; background tasks cannot.
      ...(jobVm ? { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' } : {}),
    },
    ...(jobVm ? { jobVm: true } : {}),
  };
  return { ...plan, policyHash: claudePolicyHash(plan) };
}
