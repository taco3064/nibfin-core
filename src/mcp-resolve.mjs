import { resolve, join, dirname } from 'node:path';
import { command } from './process.mjs';
import { requireThat, digest } from './identity.mjs';
import { inheritUserMcp, disabledMcpServer } from './mcp-profile.mjs';
import { readNativeMcpConfiguration } from './mcp-native.mjs';
import { rootOwnedPath } from './host-paths.mjs';

export const compatibleMcpVersion = version =>
  typeof version === 'string' &&
    /^codex-cli 0\.166\.0(?:-alpha\.\d+)?$/.test(version);

function samePath(first, second) {
  if (typeof first !== 'string') return false;
  const normalized = path => process.platform === 'win32'
    ? resolve(path).toLowerCase() : resolve(path);
  return normalized(first) === normalized(second);
}

// Shared native resolution for local sources and the owner-operated exporter.
// Credentials are supplied by a separately verified private file reader.
export async function resolveUserMcp(source, {
  environment = process.env, credentials = {}, run = command,
  nativeRead = readNativeMcpConfiguration, validateSystemFile = rootOwnedPath,
} = {}) {
  const env = {
    ...environment, CODEX_HOME: source.home, HOME: dirname(source.home),
  };
  const options = { cwd: source.home, env, timeout: 15000 };
  const version = (await run(source.codex, ['--version'], {
    ...options, limit: 1024,
  })).stdout.toString().trim();
  requireThat(compatibleMcpVersion(version), 'UNVERIFIED_USER_MCP_CLI_VERSION');
  const resolved = await nativeRead(source.codex, options);
  requireThat(Array.isArray(resolved.layers) && resolved.layers.length > 0,
    'USER_MCP_PROVENANCE_UNAVAILABLE');
  for (const layer of resolved.layers) {
    requireThat(['system', 'user'].includes(layer.name?.type) &&
      !layer.name.profile && !layer.disabledReason,
    'USER_MCP_CONFIG_LAYER_UNSUPPORTED');
    if (layer.name.type === 'user')
      requireThat(samePath(layer.name.file, join(source.home, 'config.toml')),
        'USER_MCP_CONFIG_LAYER_UNSUPPORTED');
    else if (Object.keys(layer.config ?? {}).length)
      await validateSystemFile(layer.name.file);
  }
  const config = resolved.config;
  const listed = await run(source.codex, ['mcp', 'list', '--json'], {
    ...options, limit: 2 * 1024 * 1024,
  });
  const inventory = JSON.parse(listed.stdout.toString());
  requireThat(Array.isArray(inventory), 'INVALID_USER_MCP_INVENTORY');
  const profile = inheritUserMcp(config.mcp_servers ?? {}, { environment, credentials });
  profile.metadata.nativeVersion = version;
  for (const item of inventory) {
    requireThat(['o_auth', 'oauth', 'not_logged_in', 'unsupported', 'bearer_token']
      .includes(item.auth_status), 'USER_MCP_AUTH_STATUS_UNSUPPORTED');
    if (item.enabled !== false && !Object.hasOwn(config.mcp_servers ?? {}, item.name))
      profile.metadata.diagnostics.push({
        name: item.name, code: 'USER_MCP_PLUGIN_CONFIGURATION_UNAVAILABLE',
      });
    const server = profile.configuration.mcp_servers[item.name];
    const fileAuth = Object.keys(server?.http_headers ?? {}).length > 0;
    const unavailable = item.auth_status === 'not_logged_in' && !fileAuth ?
      'USER_MCP_EXISTING_LOGIN_UNAVAILABLE' :
      ['oauth', 'o_auth'].includes(item.auth_status) && !fileAuth ?
        'USER_MCP_NATIVE_KEYRING_UNAVAILABLE' : null;
    if (item.enabled !== false && server?.enabled !== false && unavailable) {
      profile.metadata.diagnostics.push({ name: item.name, code: unavailable });
      requireThat(server?.required !== true, 'REQUIRED_USER_MCP_UNAVAILABLE');
      if (server) profile.configuration.mcp_servers[item.name] = disabledMcpServer();
    }
  }
  profile.metadata.sourceHash = digest(resolved.layers.map(layer => ({
    name: layer.name, version: layer.version,
  })));
  return profile;
}

export function bindMcpProfile(profile) {
  profile.metadata.hosts = [...new Set(Object.values(
    profile.configuration.mcp_servers,
  ).filter(server => server.enabled !== false && server.url)
    .map(server => new URL(server.url).hostname))].sort();
  profile.policyHash = digest({ metadata: profile.metadata,
    servers: profile.configuration.mcp_servers });
  return profile;
}
