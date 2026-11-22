import { ToolEnvironmentPreparer } from './tool-environment.mjs';
import { CodexSandbox } from './codex-sandbox.mjs';
import { OfflineSandbox } from './sandbox.mjs';
import { executionProfile } from './execution-profiles.mjs';
import { requireThat } from './identity.mjs';
import { dockerBackend } from './docker-backend.mjs';
import { issueContainerLabel, runnerGatewayLabel } from './host-containers.mjs';

// Fixed installed composition, never an adapter module or command from JSON.
// POSIX storage, host adoption and process controls remain backend restrictions.
// `provider` comes from the adopted binding; only Claude is named, so Codex
// sandbox and preparer arguments carry no provider key.
export async function codexEnvironment(profile, coreRoot, runner, project, {
  AgentSandbox = CodexSandbox, HookSandbox = OfflineSandbox,
  toolEnvironment = jobToolEnvironment(project?.tools), provider,
} = {}) {
  requireThat(provider === undefined || provider === 'claude',
    'PROVIDER_COMPOSITION_UNAVAILABLE');
  const claude = provider === 'claude' ? { provider } : undefined;
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
  const image = await (claude ? toolEnvironment(profile, backend, claude)
    : toolEnvironment(profile, backend));
  const containerLabel = runner ? issueContainerLabel(profile.issue) : undefined;
  const gatewayLabel = runner ? runnerGatewayLabel(runner.gateway ?? runner) : undefined;
  return Object.freeze({
    image: image ?? profile.agent.image,
    agent: new AgentSandbox({ ...profile.agent, coreRoot, ...claude,
      ...(image ? { image } : {}),
      projectTools: project?.tools, additionalDomains: project?.allowedDomains },
      { backend, containerLabel, gatewayLabel, gatewayImage: profile.agent.image }),
    hooks: new HookSandbox({ ...profile.hooks, ...(image ? { image } : {}) },
      { backend, containerLabel, projectTools: project?.tools }),
  });
}

// Retain one result (including rejection) per admitted Job, never across Jobs.
export function jobToolEnvironment(tools, Preparer = ToolEnvironmentPreparer) {
  let pending;
  // `options` carries the adopted provider (Claude only) to the preparer.
  return (profile, backend, options) => {
    if (!tools || !Object.keys(tools).length) return Promise.resolve(null);
    pending ??= new Preparer({
      docker: profile.agent.docker, socket: profile.agent.socket,
    }, { backend, baseImage: profile.agent.image, ...options }).prepare(tools);
    return pending;
  };
}
