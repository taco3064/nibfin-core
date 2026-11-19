import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { machine } from 'node:os';
import { digest, requireThat } from './identity.mjs';
import { platformContract } from './shared-platform.mjs';
import { installedProvider, validateProviderUpdate } from './provider-binding.mjs';

const fixedFiles = [
  'src/security/shared-worker-dispatcher.sh',
  'src/security/nibfin-shared-runner.service.template',
];

// Callers verify each package before inspecting its compatibility. These facts
// describe the runtime already outside the replaced Core directory, not a list
// of approved Core releases or a prerequisite for ordinary Issue work.
export async function coreOnlyRuntimeFacts(directory, arch, read = readFile) {
  const node = (await read(join(directory, '.node-version'), 'utf8')).trim();
  const contract = platformContract(JSON.parse(await read(join(directory,
    'src/shared-platform.json'), 'utf8')), node);
  const target = contract.targets[arch];
  requireThat(target, 'UNSUPPORTED_SHARED_PLATFORM');
  const files = {};
  for (const path of fixedFiles) files[path] = await read(join(directory, path), 'utf8');
  return { node, artifactArch: target.artifactArch, elfMachine: target.elfMachine,
    nodeSha256: target.nodeSha256, observations: target.observations, files };
}

function hostLifetime(host) {
  const provider = installedProvider(host);
  return {
    schemaVersion: host.schemaVersion, kind: host.kind, uid: host.uid,
    runnerUid: host.runnerUid, runnerId: host.runnerId, memberId: host.memberId,
    stateRoot: host.stateRoot, tokenFile: host.tokenFile, authFile: host.authFile,
    installation: host.installation?.directory, sharedRunner: host.sharedRunner,
    isolation: host.repository?.isolation, provider: provider.provider,
    credentialKind: provider.credentialKind,
    components: Object.fromEntries(Object.entries(provider.components)
      .filter(([key]) => key !== 'source')),
  };
}

// Configuration-specific source and enrollment checks remain with the existing
// rollout validators. This policy refuses changes that need the stopped-pool
// route; it never requests or performs Runner maintenance as a side effect.
export function classifyCoreOnlyUpdate(hosts, before, after, {
  kernel = machine(), runtime = process.arch,
} = {}) {
  requireThat(Array.isArray(hosts) && hosts.length > 0,
    'CORE_ONLY_HOSTS_REQUIRED');
  const reasons = [];
  const runtimeIdentity = value => ({ node: value.node,
    artifactArch: value.artifactArch, elfMachine: value.elfMachine,
    nodeSha256: value.nodeSha256, files: value.files });
  if (digest(runtimeIdentity(before)) !== digest(runtimeIdentity(after)) ||
      !after.observations.includes(kernel) || !after.observations.includes(runtime))
    reasons.push('installed-runtime-or-service-change');
  for (const { current, next } of hosts) {
    try {
      validateProviderUpdate(current, next);
      if (digest(hostLifetime(current)) !== digest(hostLifetime(next)))
        reasons.push('pool-layout-provider-or-credential-change');
    } catch (error) {
      reasons.push(error.code ?? 'incompatible-host-configuration');
    }
  }
  return reasons.length ? { status: 'unsupported',
    code: 'CORE_ONLY_MAINTENANCE_REQUIRED', reasons: [...new Set(reasons)] } :
    { status: 'compatible', mode: 'core-only' };
}
