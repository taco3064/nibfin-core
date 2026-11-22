import { codexStageExecutor } from './codex-stage.mjs';
import { installedProvider } from './provider-binding.mjs';
import { claudeVersionPattern } from './claude-agent-plan.mjs';
import { digest, requireThat } from './identity.mjs';

// Each adopted provider's own component checks beyond the shared identity.
// Codex binds its login file; Claude binds its CLI version and credential kind.
const providerChecks = Object.freeze({
  codex: (options, adopted) => options.authFile === adopted.authFile,
  claude: options => claudeVersionPattern.test(options.isolation?.agent?.codexVersion),
});

// Finite code-owned selection before project tools are prepared. Neither project
// configuration nor stage input can replace this function or register a provider.
export function installedProviderExecutor(host) {
  const adopted = structuredClone(host);
  const binding = installedProvider(adopted);
  requireThat(Object.hasOwn(providerChecks, binding.provider),
    'PROVIDER_COMPOSITION_UNAVAILABLE');
  return options => {
    const current = installedProvider(adopted, options.provider);
    requireThat(options.model === current.modelProfile.model &&
      digest(options.installation) === digest(adopted.installation) &&
      options.isolation?.kind === current.components.hostProfile &&
      options.isolation?.agent?.image === current.components.agentImage &&
      providerChecks[current.provider](options, adopted),
    'PROVIDER_COMPONENT_MISMATCH');
    // The binding is the single provider source; Codex options stay unchanged.
    if (current.provider === 'codex') return codexStageExecutor(options);
    return codexStageExecutor({ ...options, provider: current.provider,
      credentialKind: current.credentialKind });
  };
}
