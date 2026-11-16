import { managedPaths } from './managed-credential-files.mjs';
import { managedModel } from './managed-model.mjs';
import { engine } from './engine-contract.mjs';
import { managedSharedAdmission } from './shared-admission-policy.mjs';

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
});
export const managedPreparationCapability = Object.freeze({
  kind: 'linux-x64-managed-resources-v1',
  executable: '/opt/nibfin/core/bin/nibfin-prepare-shared-host.mjs',
  arguments: Object.freeze(['--consent-resource-preparation']),
  statuses: Object.freeze(['prepared', 'denied', 'pending']),
  preparedCode: 'MANAGED_RESOURCES_PREPARED',
  profile: managedResources.profile,
  resultKeys: Object.freeze(['status', 'code', 'profile', 'images',
    'adoption', 'servicesReady']),
  imageKeys: Object.freeze(['agent', 'hooks']),
  exitCodes: Object.freeze({ prepared: 0, denied: 1, pending: 2 }),
  adoption: false,
  servicesReady: false,
  credentialsRequired: false,
  registrationsRequired: false,
});

export function managedProfile(namespace, images) {
  const isolation = slot => ({
    kind: 'linux-rootful-docker-v1', namespace: structuredClone(namespace),
    agent: {
      docker: '/usr/bin/docker', socket: engine.socket, image: images.agent,
      codexVersion: 'codex-cli 0.166.0',
      mcpPolicyDirectory: `/var/lib/nibfin/controller/slot-${slot}/egress`,
    },
    hooks: { docker: '/usr/bin/docker', socket: engine.socket, image: images.hooks },
  });
  return {
    schemaVersion: 1, ...managedPaths, model: managedModel,
    sharedAdmission: managedSharedAdmission,
    managedEgressNetwork: managedResources.egress,
    isolation: isolation(1), secondaryIsolation: isolation(2),
  };
}

export function preparedResult(images) {
  return { status: 'prepared', code: managedPreparationCapability.preparedCode,
    profile: managedResources.profile, images: { ...images },
    adoption: false, servicesReady: false };
}
