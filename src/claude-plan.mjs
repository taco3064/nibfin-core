import { privatePlanContract } from './provider-contract.mjs';
import { digest, requireThat } from './identity.mjs';
import { resultSchema } from './agent-result.mjs';
import { rolePrompt } from './role-prompt.mjs';
import {
  claudeTools, claudeWorkChannel, claudeWorkServer,
} from './claude-work-channel.mjs';

export { claudeTools };

export const claudeLimits = Object.freeze({
  stdin: 1024 * 1024, stdout: 8 * 1024 * 1024, stderr: 64 * 1024,
  timeoutMs: 30 * 60 * 1000,
});

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
    component.toolChannel === claudeWorkChannel,
  'CLAUDE_PREREQUISITE_UNAVAILABLE');
  const tools = claudeTools(stage);
  const mcp = { mcpServers: { work: claudeWorkServer() } };
  const settings = { disableAllHooks: true, enabledPlugins: {} };
  // No --bare: it reads only API keys, never the subscription OAuth token. The
  // explicit sources, MCP, hooks, plugins and commands below keep its isolation;
  // the runner adds the container environment and a fresh, empty /session.
  const args = [
    '--print', '--input-format', 'text', '--output-format', 'json',
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
      CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1',
      PATH: '/usr/local/bin:/usr/bin:/bin' },
    // The runner enforces these properties; they are not isolation evidence.
    repositoryMounts: false, cleanConfig: true, tools,
    limits: claudeLimits, cli: structuredClone(component.cli), contract };
  return { ...policy, executable: component.cli.executable, prompt,
    schema: structuredClone(resultSchema), policyHash: digest(policy) };
}
