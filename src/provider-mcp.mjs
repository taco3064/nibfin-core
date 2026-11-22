import { installedProvider } from './provider-binding.mjs';

// Claude has no user MCP route. A configured source (host or target repository)
// is unsupported on a Claude pool; proposal runs never reach this check.
export function unsupportedMcp(host, mcpSource) {
  if (mcpSource === undefined) return false;
  return installedProvider(host).provider === 'claude';
}
