import { codexStageExecutor } from './codex-stage.mjs';
import { installedProvider } from './provider-binding.mjs';
import { digest, requireThat } from './identity.mjs';

// Finite code-owned selection before project tools are prepared. Neither project
// configuration nor stage input can replace this function or register a provider.
export function installedProviderExecutor(host) {
  const adopted = structuredClone(host);
  const binding = installedProvider(adopted);
  requireThat(binding.provider === 'codex', 'PROVIDER_COMPOSITION_UNAVAILABLE');
  return options => {
    const current = installedProvider(adopted, options.provider);
    requireThat(options.model === current.modelProfile.model &&
      digest(options.installation) === digest(adopted.installation) &&
      options.authFile === adopted.authFile &&
      options.isolation?.kind === current.components.hostProfile &&
      options.isolation?.agent?.image === current.components.agentImage,
    'PROVIDER_COMPONENT_MISMATCH');
    return codexStageExecutor(options);
  };
}
