import { requireThat, digest } from './identity.mjs';

const modes = new Set(['auto', 'approve', 'prompt', 'writes']);
export const disabledMcpServer = () => ({
  url: 'https://disabled.invalid/mcp', enabled: false,
});
const fields = new Set([
  'url', 'enabled', 'enabled_tools', 'disabled_tools', 'http_headers',
  'env_http_headers', 'bearer_token_env_var', 'auth', 'oauth',
  'oauth_resource', 'required', 'startup_timeout_sec', 'startup_timeout_ms',
  'tool_timeout_sec', 'default_tools_approval_mode', 'tools',
  'supports_parallel_tool_calls', 'startup_readiness', 'omit_tools_from',
  'tool_input_schema_max_bytes', 'environment_id',
]);

function plain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function toolNames(value) {
  requireThat(
    Array.isArray(value) && value.every(x => typeof x === 'string' && x),
    'INVALID_USER_MCP_TOOL_FILTER',
  );
  return structuredClone(value);
}

// MCP writes can bypass local read-only filesystems and Core's publisher.
// Preserve stricter user prompts; never turn a prompt into automatic permission.
function approval(value = 'auto') {
  requireThat(modes.has(value), 'INVALID_USER_MCP_APPROVAL_MODE');
  return value === 'prompt' ? 'prompt' : 'writes';
}

function headers(value = {}) {
  requireThat(plain(value), 'INVALID_USER_MCP_HEADERS');
  const names = new Set();
  for (const [key, item] of Object.entries(value)) {
    requireThat(!['host', 'connection', 'content-length', 'transfer-encoding',
      'proxy-authorization', 'mcp-session-id', 'mcp-protocol-version']
      .includes(key.toLowerCase()), 'UNSAFE_USER_MCP_HEADER');
    requireThat(
      /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) &&
        typeof item === 'string' && !/[\r\n\x00]/.test(item),
      'INVALID_USER_MCP_HEADERS',
    );
    requireThat(!names.has(key.toLowerCase()), 'DUPLICATE_USER_MCP_HEADER');
    names.add(key.toLowerCase());
  }
  return structuredClone(value);
}

function environmentValue(name, environment) {
  requireThat(
    typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) &&
      typeof environment[name] === 'string' && environment[name],
    'USER_MCP_ENVIRONMENT_UNAVAILABLE',
  );
  return environment[name];
}

function existingAccessToken(name, url, credentials, now, minimumLifetime) {
  const matches = Object.values(credentials).filter(entry =>
    plain(entry) && !entry.executor_owned && entry.server_url === url &&
      [name, `local:${name}`].includes(entry.server_name));
  requireThat(matches.length <= 1, 'AMBIGUOUS_USER_MCP_CREDENTIAL');
  if (!matches.length) return null;
  const entry = matches[0];
  requireThat(
    typeof entry.access_token === 'string' && entry.access_token &&
      Number.isSafeInteger(entry.expires_at) &&
      entry.expires_at > now + minimumLifetime,
    'USER_MCP_AUTHENTICATION_REFRESH_REQUIRED',
  );
  // Delegate a current access token only. Never copy/rotate a refresh token or
  // overwrite the user's native credential store from an isolated role.
  return { token: entry.access_token, expiresAt: entry.expires_at };
}

function inheritedHttp(name, original, options) {
  requireThat(original.auth !== 'chatgpt',
    'USER_MCP_CHATGPT_AUTH_DELEGATION_UNAVAILABLE');
  requireThat(Object.keys(original).every(key => fields.has(key)),
    'UNSUPPORTED_USER_MCP_SETTING');
  const endpoint = new URL(original.url);
  requireThat(
    endpoint.protocol === 'https:' && !endpoint.username && !endpoint.password &&
      !endpoint.hash && (!endpoint.port || endpoint.port === '443'),
    'UNSUPPORTED_USER_MCP_ENDPOINT',
  );
  requireThat(
    original.environment_id === undefined || original.environment_id === 'local',
    'USER_MCP_EXECUTOR_UNAVAILABLE',
  );
  const server = structuredClone(original);
  server.http_headers = headers(server.http_headers);
  for (const [key, variable] of Object.entries(server.env_http_headers ?? {})) {
    server.http_headers[key] = environmentValue(variable, options.environment);
  }
  delete server.env_http_headers;
  if (server.bearer_token_env_var) {
    const value = environmentValue(server.bearer_token_env_var, options.environment);
    server.http_headers.Authorization = `Bearer ${value}`;
    delete server.bearer_token_env_var;
  }
  headers(server.http_headers);
  const hasAuthorization = Object.keys(server.http_headers)
    .some(key => key.toLowerCase() === 'authorization');
  let expiresAt = null;
  if (!hasAuthorization) {
    const token = existingAccessToken(name, original.url, options.credentials,
      options.now, options.minimumLifetime);
    if (token) {
      server.http_headers.Authorization = `Bearer ${token.token}`;
      expiresAt = token.expiresAt;
    }
  }
  if (server.enabled_tools !== undefined)
    server.enabled_tools = toolNames(server.enabled_tools);
  if (server.disabled_tools !== undefined)
    server.disabled_tools = toolNames(server.disabled_tools);
  server.default_tools_approval_mode = approval(server.default_tools_approval_mode);
  requireThat(server.tools === undefined || plain(server.tools),
    'INVALID_USER_MCP_TOOL_POLICY');
  server.tools = Object.fromEntries(Object.entries(server.tools ?? {}).map(
    ([tool, policy]) => {
      requireThat(plain(policy), 'INVALID_USER_MCP_TOOL_POLICY');
      return [tool, {
        ...policy, approval_mode: approval(policy.approval_mode ??
          original.default_tools_approval_mode),
      }];
    },
  ));
  return { server, hostname: endpoint.hostname, expiresAt };
}

// Only a trusted host composition supplies these arguments. Never accept this
// object through Issue context, Agent output, Candidate or Workflow inputs.
export function inheritUserMcp(configuration, {
  environment = {}, credentials = {}, now = Date.now(),
  minimumLifetime = 31 * 60 * 1000,
} = {}) {
  requireThat(plain(configuration) && plain(credentials), 'INVALID_USER_MCP_CONFIG');
  requireThat(Number.isSafeInteger(now) && Number.isSafeInteger(minimumLifetime) &&
    minimumLifetime >= 0, 'INVALID_USER_MCP_AUTH_WINDOW');
  const servers = {}, diagnostics = [], hosts = new Set(), secrets = new Set();
  let expiresAt = null;
  for (const [name, original] of Object.entries(configuration)) {
    requireThat(/^[A-Za-z0-9_-]+$/.test(name) && plain(original),
      'INVALID_USER_MCP_SERVER');
    if (original.enabled === false) {
      servers[name] = disabledMcpServer();
      continue;
    }
    try {
      // STDIO servers execute outside Codex's command sandbox. Keep them visible
      // as unavailable until a separately proven launch boundary exists.
      requireThat(typeof original.url === 'string' && !original.command,
        'USER_MCP_STDIO_ISOLATION_UNAVAILABLE');
      const result = inheritedHttp(name, original, {
        environment, credentials, now, minimumLifetime,
      });
      servers[name] = result.server;
      if (result.expiresAt !== null)
        expiresAt = Math.min(expiresAt ?? result.expiresAt, result.expiresAt);
      hosts.add(result.hostname);
      for (const value of Object.values(result.server.http_headers)) {
        if (value.length >= 8) secrets.add(value);
        const bearer = /^Bearer\s+(.+)$/i.exec(value);
        if (bearer) secrets.add(bearer[1]);
      }
      const endpoint = new URL(original.url);
      for (const value of endpoint.searchParams.values())
        if (value.length >= 8) secrets.add(value);
      if (typeof result.server.oauth?.client_secret === 'string')
        secrets.add(result.server.oauth.client_secret);
      for (const entry of Object.values(credentials)) {
        if (entry?.server_url !== original.url) continue;
        if (typeof entry.access_token === 'string') secrets.add(entry.access_token);
      }
    } catch (error) {
      diagnostics.push({ name, code: error.code ?? 'INVALID_USER_MCP_CONFIG' });
      // Preserve configured intent in the private profile, without launching an
      // unsupported transport or silently treating it as inherited and usable.
      servers[name] = disabledMcpServer();
      requireThat(original.required !== true, 'REQUIRED_USER_MCP_UNAVAILABLE');
    }
  }
  const metadata = {
    servers: Object.keys(servers), hosts: [...hosts].sort(), diagnostics,
  };
  return {
    configuration: { mcp_servers: servers, mcp_oauth_credentials_store: 'file' },
    metadata, policyHash: digest({ metadata, servers }), secrets: [...secrets],
    expiresAt,
  };
}

// Restricted TOML serialization, not shell escaping. The result is PRIVATE
// configuration: it must never enter argv, prompts, public input or receipts.
export function privateMcpToml(profile) {
  const encode = value => {
    if (typeof value === 'string' || typeof value === 'boolean' ||
        typeof value === 'number' && Number.isFinite(value))
      return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(encode).join(', ')}]`;
    requireThat(plain(value), 'INVALID_USER_MCP_TOML_VALUE');
    return `{ ${Object.entries(value).filter(([, item]) => item != null)
      .map(([key, item]) =>
      `${JSON.stringify(key)} = ${encode(item)}`).join(', ')} }`;
  };
  return Object.entries(profile.configuration).map(([key, value]) =>
    `${JSON.stringify(key)} = ${encode(value)}\n`).join('');
}
