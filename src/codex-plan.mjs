import { privatePlanContract, validProviderModel } from './provider-contract.mjs';
import { digest, requireThat } from './identity.mjs';
import { projectToolPath } from './tool-catalog.mjs';
import { resultSchema } from './agent-result.mjs';
import { skillIdentity } from './skills.mjs';
import { toolDownloadHosts, projectDomains } from './egress-proxy.mjs';
import { rolePrompt } from './role-prompt.mjs';
import { writerTemporaryDirectory } from './agent-scratch.mjs';

// Fixed paths belong to the isolated image contract, never the candidate. The
// controller starts in /session, outside /work, to avoid candidate configuration
// discovery. Configuration alone is not proof that a host enforces this policy.
export function codexPlan(stage, {
  model, threadId = null, skill, context, mcpPolicyHash = null, hasProposal = false,
  globalInstructions, additionalDomains, projectTools,
}) {
  const identity = skillIdentity(stage);
  requireThat(
    validProviderModel(model) &&
    skill?.identity === identity && typeof skill.content === 'string' &&
    digest(skill.content) === skill.hash,
    'INVALID_CODEX_PLAN',
  );
  requireThat(threadId === null, 'CROSS_EXECUTION_RESUME_FORBIDDEN');
  requireThat(mcpPolicyHash === null || /^[a-f0-9]{64}$/.test(mcpPolicyHash),
    'INVALID_USER_MCP_POLICY');
  const selectedDomains = projectDomains(additionalDomains);
  const contract = privatePlanContract(stage, { model });
  const writable = contract.capabilities.workspace === 'write';
  const temporaryDirectory = '/work/' + writerTemporaryDirectory;
  const config = {
    model, approval_policy: 'never', default_permissions: 'nibfin',
    web_search: 'disabled',
    'features.apps': false, 'features.multi_agent': false,
    'skills.bundled.enabled': false,
    'projects."/work".trust_level': 'untrusted',
    'projects."/session".trust_level': 'untrusted',
    'shell_environment_policy.inherit': 'none',
    'shell_environment_policy.experimental_use_profile': false,
    'shell_environment_policy.ignore_default_excludes': false,
    'shell_environment_policy.set': {
      PATH: projectToolPath, HOME: writable ? '/work' : '/tmp/tool-home',
      LANG: 'C.UTF-8',
      GOMAXPROCS: '2', GOFLAGS: '-p=1',
      ...(writable && {
        TMPDIR: temporaryDirectory, TMP: temporaryDirectory, TEMP: temporaryDirectory,
        XDG_CACHE_HOME: '/work/.nibfin-cache',
        XDG_CONFIG_HOME: '/work/.nibfin-cache/config',
        GOCACHE: '/work/.nibfin-cache/go-build', GOPATH: '/work/.nibfin-cache/go',
        PIP_CACHE_DIR: '/work/.nibfin-cache/pip',
        npm_config_cache: '/work/.nibfin-cache/npm',
      }),
    },
    'permissions.nibfin.filesystem': {
      ':minimal': 'read', '/work': writable ? 'write' : 'read', '/input': 'read',
      // Deliver may generate files only in its assigned repository. Other
      // roles retain their separate disposable verification facility.
      '/main': 'read', '/tmp': writable ? 'read' : 'write',
      '/tmp/.git': writable ? 'read' : 'write',
      '/auth': 'deny', '/agent-home': 'deny',
      '/io': 'deny', '/session': 'read', '/proc': 'read',
      '/opt/nibfin/project': 'read',
      ...(writable && {
        '/usr/bin': 'read', '/usr/local': 'read', '/usr/lib': 'read',
        '/usr/include': 'read', '/usr/share': 'read',
      }),
    },
    'permissions.nibfin.network.enabled': true,
  };
  // JSON string and inline-table serialization is a restricted TOML encoder,
  // not shell escaping. Every value goes directly into a distinct argv element.
  const toml = value => typeof value === 'object'
    ? `{ ${Object.entries(value).map(([key, item]) =>
      `${JSON.stringify(key)} = ${toml(item)}`).join(', ')} }`
    : JSON.stringify(value);
  const settings = Object.entries(config).flatMap(([key, value]) =>
    ['-c', `${key}=${toml(value)}`]);
  const requirements = [
    'allowed_approval_policies = ["never", "untrusted"]',
    'allowed_login_methods = ["chatgpt"]',
    'allowed_web_search_modes = ["disabled"]',
    'allow_login_shell = false',
    'allow_managed_hooks_only = true',
    'allow_browser_and_computer_use = false',
    'allow_remote_control = false',
    'default_permissions = "nibfin"',
    '[allowed_permission_profiles]',
    'nibfin = true',
    '[features]',
    'apps = false',
    'multi_agent = false',
    '[network_proxy]',
    'enabled = true',
    'managed_allowed_domains_only = true',
    'allow_upstream_proxy = true',
    // The adopted gateway is on the private Docker network.
    'allow_local_binding = true',
    'allowed_domains = ' +
      JSON.stringify([...new Set([...toolDownloadHosts, ...selectedDomains])]),
    '',
  ].join('\n');
  const args = [
    ...settings, 'exec', ...(mcpPolicyHash ? [] : ['--ignore-user-config']),
    '--json', '--skip-git-repo-check',
    '--output-schema', '/input/result-schema.json',
    '--output-last-message', '/io/result.json', '-',
  ];
  const prompt = rolePrompt(stage, { skill, context, hasProposal,
    globalInstructions, projectTools });
  return {
    contract,
    additionalDomains: selectedDomains,
    args, config, settings, requirements, schema: resultSchema, prompt,
    expectedThread: threadId, writable, mcpPolicyHash,
    projectPython: projectTools?.python ?? null,
    policyHash: digest({ config, requirements }),
    cwd: '/session',
    environment: {
      CODEX_HOME: '/agent-home', HOME: '/session', PATH: '/usr/local/bin:/usr/bin:/bin',
    },
  };
}
