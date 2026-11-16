import { privatePlanContract } from './provider-contract.mjs';
import { digest, requireThat } from './identity.mjs';
import { resultSchema } from './agent-result.mjs';
import { rolePrompt } from './role-prompt.mjs';

export const claudeLimits = Object.freeze({
  stdin: 1024 * 1024, stdout: 8 * 1024 * 1024, stderr: 64 * 1024,
  timeoutMs: 30 * 60 * 1000,
});
const readTools = ['mcp__work__read', 'mcp__work__check'];
export function claudeTools(stage) {
  const contract = privatePlanContract(stage, { model: 'validation' });
  return [...readTools, ...(contract.capabilities.workspace === 'write'
    ? ['mcp__work__write'] : [])];
}

// Trusted component configuration only. This does not verify an installation or
// implement the channel: the runner must attest its actual executable and tools.
export function claudePlan(stage, options, component) {
  const allowed = ['modelProfile', 'skill', 'context', 'hasProposal',
    'globalInstructions', 'projectTools'];
  requireThat(options && Object.keys(options).every(key => allowed.includes(key)),
    'CLAUDE_CONFIGURATION_OVERRIDE');
  const { modelProfile, skill, context } = options;
  const contract = privatePlanContract(stage, modelProfile);
  requireThat(Object.keys(modelProfile).length === 1 &&
    skill?.identity === contract.skill && typeof skill.content === 'string' &&
    digest(skill.content) === skill.hash && context && typeof context === 'object',
  'INVALID_CLAUDE_PLAN');
  requireThat(component?.cli?.package === '@anthropic-ai/claude-code' &&
    typeof component.cli.version === 'string' &&
    /^\d+\.\d+\.\d+$/.test(component.cli.version) &&
    component.cli.executable === '/opt/nibfin/claude/bin/claude' &&
    component.runner === 'claude-private-runner-v1' &&
    component.toolChannel === 'claude-scoped-work-v1',
  'CLAUDE_PREREQUISITE_UNAVAILABLE');
  const tools = claudeTools(stage);
  const mcp = { mcpServers: {
    work: { type: 'http', url: 'http://work-tools:8080/mcp' },
  } };
  const settings = { disableAllHooks: true, enabledPlugins: {} };
  const args = [
    '--bare', '--print', '--input-format', 'text', '--output-format', 'json',
    '--model', modelProfile.model, '--json-schema', JSON.stringify(resultSchema),
    '--tools', '', '--allowedTools', tools.join(','),
    '--strict-mcp-config', '--mcp-config', JSON.stringify(mcp),
    '--setting-sources', '', '--settings', JSON.stringify(settings),
    '--disable-slash-commands', '--no-session-persistence', '--no-chrome',
    '--permission-mode', 'default',
  ];
  const prompt = rolePrompt(stage, options);
  requireThat(Buffer.byteLength(prompt) <= claudeLimits.stdin,
    'CLAUDE_INPUT_LIMIT');
  const policy = { args, cwd: '/session',
    environment: { HOME: '/session', CLAUDE_CONFIG_DIR: '/session/config',
      PATH: '/usr/local/bin:/usr/bin:/bin' },
    // The runner enforces these properties; they are not isolation evidence.
    repositoryMounts: false, cleanConfig: true, tools,
    limits: claudeLimits, cli: structuredClone(component.cli), contract };
  return { ...policy, executable: component.cli.executable, prompt,
    schema: structuredClone(resultSchema), policyHash: digest(policy) };
}
