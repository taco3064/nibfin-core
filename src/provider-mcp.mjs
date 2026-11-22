import { installedProvider } from './provider-binding.mjs';
import { requireThat } from './identity.mjs';

// Claude has no user MCP route. A configured source (host or target repository)
// refuses before any MCP preparation; proposal runs never reach this check.
export function refuseUnsupportedMcp(host, mcpSource) {
  if (mcpSource === undefined) return;
  requireThat(installedProvider(host).provider !== 'claude', 'CLAUDE_MCP_UNSUPPORTED');
}
