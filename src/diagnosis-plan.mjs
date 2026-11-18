import { safeReportText } from './blocker-report.mjs';
import { digest, requireThat } from './identity.mjs';
import { validProviderModel } from './provider-contract.mjs';

export const diagnosisSchema = {
  type: 'object', additionalProperties: false,
  required: ['explanation', 'hypotheses', 'missing'],
  properties: {
    explanation: { type: 'string', maxLength: 1024 },
    hypotheses: { type: 'array', maxItems: 8,
      items: { type: 'string', maxLength: 256 } },
    missing: { type: 'array', maxItems: 8,
      items: { type: 'string', maxLength: 256 } },
  },
};

export function diagnosisPlan(model, evidence) {
  requireThat(validProviderModel(model) && Array.isArray(evidence) &&
    Buffer.byteLength(JSON.stringify(evidence)) <= 32 * 1024, 'DIAGNOSIS_INPUT_LIMIT');
  const config = { model, approval_policy: 'never', default_permissions: 'nibfin',
    web_search: 'disabled',
    'features.apps': false, 'features.multi_agent': false,
    'skills.bundled.enabled': false,
    'shell_environment_policy.inherit': 'none',
    'permissions.nibfin.filesystem': {
      ':minimal': 'read', '/input': 'read', '/session': 'read', '/tmp': 'deny',
      '/auth': 'deny', '/agent-home': 'deny', '/io': 'deny', '/proc': 'deny',
      '/work': 'deny', '/main': 'deny',
    },
    'permissions.nibfin.network.enabled': false };
  const toml = value => typeof value === 'object'
    ? `{ ${Object.entries(value).map(([key, item]) =>
      `${JSON.stringify(key)} = ${toml(item)}`).join(', ')} }`
    : JSON.stringify(value);
  const settings = Object.entries(config).flatMap(([key, value]) =>
    ['-c', `${key}=${toml(value)}`]);
  const requirements = [
    'allowed_approval_policies = ["never"]',
    'allowed_login_methods = ["chatgpt"]',
    'allowed_web_search_modes = ["disabled"]',
    'allow_login_shell = false', 'allow_managed_hooks_only = true',
    'allow_browser_and_computer_use = false', 'allow_remote_control = false',
    'default_permissions = "nibfin"', '[allowed_permission_profiles]',
    'nibfin = true', '[features]', 'apps = false', 'multi_agent = false',
    '[network_proxy]', 'enabled = true', 'managed_allowed_domains_only = true',
    'allow_upstream_proxy = true', 'allow_local_binding = true',
    'allowed_domains = []', '',
  ].join('\n');
  return { contract: { kind: 'read-only-diagnosis-v1' },
    diagnosis: true, timeout: 120_000, additionalDomains: [], writable: false,
    mcpPolicyHash: null, config, settings, requirements,
    policyHash: digest({ config, requirements }), schema: diagnosisSchema,
    args: [...settings, 'exec', '--json', '--skip-git-repo-check',
      '--output-schema', '/input/result-schema.json',
      '--output-last-message', '/io/result.json', '-'],
    prompt: 'Explain only this sanitized evidence. No tools are available. ' +
      'Do not run commands, build, retry CI, edit or resume delivery. ' +
      'Separate hypotheses from observations. Exit 137 alone has unknown cause. ' +
      'Container OOM is not host OOM. Return the fixed JSON schema.\n' +
      JSON.stringify(evidence),
    environment: { CODEX_HOME: '/agent-home', HOME: '/session',
      PATH: '/usr/local/bin:/usr/bin:/bin' } };
}

export function safeDiagnosisResult(value) {
  const safe = (text, limit) => typeof text === 'string' && text.length > 0 &&
    text.length <= limit && safeReportText(text) !== null;
  requireThat(value && Object.keys(value).sort().join(',') ===
    'explanation,hypotheses,missing' && safe(value.explanation, 1024) &&
    ['hypotheses', 'missing'].every(key => Array.isArray(value[key]) &&
      value[key].length <= 8 && value[key].every(item => safe(item, 256))),
  'UNSAFE_DIAGNOSIS_RESULT');
  return { producer: 'diagnosis-agent', confidence: 'attributed',
    explanation: value.explanation, hypotheses: value.hypotheses,
    missing: value.missing, executionAuthority: false };
}
