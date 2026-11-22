import { managedPaths } from './managed-credential-files.mjs';
import { managedModel, managedModels } from './managed-model.mjs';
import { engine } from './engine-contract.mjs';
import { managedSharedAdmission } from './shared-admission-policy.mjs';
import { claudeAppArmorProfile } from './claude-agent-plan.mjs';

export const managedResources = Object.freeze({
  state: '/var/lib/nibfin-resource-prepare',
  profile: '/etc/nibfin/shared-host-profile.json',
  egress: 'nibfin-managed-egress',
  label: 'io.nibfin.resource-preparation',
  policy: '/etc/apparmor.d/nibfin-managed-codex',
  apparmor: 'codex-security-container',
  recipes: Object.freeze({
    agent: 'managed-agent.Dockerfile', hooks: 'managed-hook.Dockerfile',
  }),
  // Prepared only on explicit request and kept out of `recipes`, so the Codex
  // Agent and Hook inputs, images and their digests stay unchanged.
  claude: Object.freeze({
    kind: 'claude-agent', recipe: 'managed-claude-agent.Dockerfile',
    package: 'claude-package.mjs', shell: 'nibfin-bash',
    policy: '/etc/apparmor.d/nibfin-managed-claude',
    apparmor: claudeAppArmorProfile, profileFile: 'nibfin-claude.apparmor',
  }),
});

// Each installed AppArmor policy: its file, kernel profile name and load proof.
// The Claude policy is installed only on an explicit Claude request.
export const policyTargets = Object.freeze({
  codex: Object.freeze({ path: managedResources.policy,
    name: managedResources.apparmor, proof: 'policy.json' }),
  claude: Object.freeze({ path: managedResources.claude.policy,
    name: managedResources.claude.apparmor, proof: 'policy-claude.json' }),
});
const preparationArguments = Object.freeze(['--consent-resource-preparation']);
const preparationImageKeys = Object.freeze(['agent', 'hooks']);
export const managedPreparationCapability = Object.freeze({
  kind: 'linux-managed-resources-v1',
  executable: '/opt/nibfin/core/bin/nibfin-prepare-shared-host.mjs',
  arguments: preparationArguments,
  statuses: Object.freeze(['prepared', 'denied', 'pending']),
  preparedCode: 'MANAGED_RESOURCES_PREPARED',
  profile: managedResources.profile,
  resultKeys: Object.freeze(['status', 'code', 'profile', 'images',
    'adoption', 'servicesReady']),
  imageKeys: preparationImageKeys,
  exitCodes: Object.freeze({ prepared: 0, denied: 1, pending: 2 }),
  adoption: false,
  servicesReady: false,
  credentialsRequired: false,
  registrationsRequired: false,
  architectures: Object.freeze(['amd64', 'arm64']),
  // Additive: the keys above stay the Codex request consumers already check.
  // A Claude request appends its agent argument; its result adds `claudeAgent`.
  agents: Object.freeze({
    claude: Object.freeze({
      arguments: Object.freeze([...preparationArguments, '--agent=claude']),
      imageKeys: Object.freeze([...preparationImageKeys, 'claudeAgent']),
    }),
  }),
});

// `claude = { image, version }` publishes the Claude Agent in both slots. Its
// CLI version keeps the `codexVersion` field the sandbox already reads. Without
// it the Codex profile is unchanged and carries no `provider` key.
export function managedProfile(namespace, images, { claude } = {}) {
  const isolation = slot => ({
    kind: 'linux-rootful-docker-v1', namespace: structuredClone(namespace),
    agent: {
      docker: '/usr/bin/docker', socket: engine.socket,
      image: claude ? claude.image : images.agent,
      codexVersion: claude ? claude.version : 'codex-cli 0.166.0',
      mcpPolicyDirectory: `/var/lib/nibfin/controller/slot-${slot}/egress`,
    },
    hooks: { docker: '/usr/bin/docker', socket: engine.socket, image: images.hooks },
  });
  return {
    schemaVersion: 1, ...claude && { provider: 'claude' }, ...managedPaths,
    model: claude ? managedModels.claude : managedModel,
    sharedAdmission: managedSharedAdmission,
    managedEgressNetwork: managedResources.egress,
    isolation: isolation(1), secondaryIsolation: isolation(2),
  };
}

// `images.claudeAgent` is added only when the Claude profile is published.
export function preparedResult(images, claudeAgent) {
  return { status: 'prepared', code: managedPreparationCapability.preparedCode,
    profile: managedResources.profile,
    images: { ...images, ...claudeAgent && { claudeAgent } },
    adoption: false, servicesReady: false };
}
