import { CodexSandbox } from './codex-sandbox.mjs';
import { OfflineSandbox } from './sandbox.mjs';
import { executionProfile } from './execution-profiles.mjs';
import { requireThat } from './identity.mjs';
import { dockerBackend } from './docker-backend.mjs';
import { issueContainerLabel, runnerGatewayLabel } from './host-containers.mjs';

// Fixed installed composition, never an adapter module or command from JSON.
// POSIX storage, host adoption and process controls remain backend restrictions.
export function codexEnvironment(profile, coreRoot, runner) {
  const selected = executionProfile(profile?.kind);
  requireThat(process.platform === selected.hostPlatform, 'UNSUPPORTED_EXECUTION_HOST');
  requireThat(
    profile.agent?.docker === profile.hooks?.docker &&
      profile.agent?.socket === profile.hooks?.socket,
    'SPLIT_HOST_DAEMON',
  );
  const backend = dockerBackend({
    kind: profile.kind,
    ...(selected.dockerMode === 'rootful' ? { namespace: profile.namespace } : {}),
  });
  const containerLabel = runner ? issueContainerLabel(profile.issue) : undefined;
  const gatewayLabel = runner ? runnerGatewayLabel(runner.gateway ?? runner) : undefined;
  return Object.freeze({
    agent: new CodexSandbox({ ...profile.agent, coreRoot },
      { backend, containerLabel, gatewayLabel }),
    hooks: new OfflineSandbox(profile.hooks, { backend, containerLabel }),
  });
}
