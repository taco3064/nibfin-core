import { requireThat, isId, isDigest } from './identity.mjs';
import { inheritUserMcp } from './mcp-profile.mjs';
import { compatibleMcpVersion, bindMcpProfile } from './mcp-resolve.mjs';
import { readPrivateMcpJson } from './mcp-files.mjs';

const maximumLifetime = 8 * 60 * 60 * 1000;
const minimumLifetime = 31 * 60 * 1000;
const keys = ['schemaVersion', 'memberId', 'issuedAt', 'expiresAt', 'nativeVersion',
  'sourcePlatform', 'sourceHash', 'servers', 'diagnostics'].sort().join(',');

export function createMcpDelegation(profile, memberId, {
  now = Date.now(), platform = process.platform,
} = {}) {
  requireThat(isId(memberId), 'INVALID_MCP_DELEGATION_MEMBER');
  const servers = structuredClone(profile.configuration.mcp_servers);
  for (const server of Object.values(servers)) {
    // The native owner keeps refresh credentials and client registration.
    delete server.oauth;
    delete server.auth;
    delete server.oauth_resource;
  }
  const value = {
    schemaVersion: 1, memberId, issuedAt: now,
    expiresAt: Math.min(profile.expiresAt ?? now + maximumLifetime,
      now + maximumLifetime),
    nativeVersion: profile.metadata.nativeVersion,
    sourcePlatform: platform, sourceHash: profile.metadata.sourceHash,
    servers, diagnostics: structuredClone(profile.metadata.diagnostics),
  };
  validateMcpDelegation(value, memberId, now);
  return value;
}

// A hash or a self-declared member does not authenticate this data. Authority is
// the Owner-operated export and private controller file selected by host adoption.
export function validateMcpDelegation(value, memberId, now = Date.now()) {
  requireThat(value && Object.keys(value).sort().join(',') === keys &&
    value.schemaVersion === 1 && isId(memberId) && value.memberId === memberId &&
    Number.isSafeInteger(value.issuedAt) && value.issuedAt <= now + 30000 &&
    Number.isSafeInteger(value.expiresAt) && value.expiresAt > now + minimumLifetime &&
    value.expiresAt <= value.issuedAt + maximumLifetime &&
    compatibleMcpVersion(value.nativeVersion) && isDigest(value.sourceHash) &&
    ['win32', 'linux', 'darwin'].includes(value.sourcePlatform),
  'INVALID_MCP_DELEGATION');
  requireThat(value.servers && typeof value.servers === 'object' &&
    !Array.isArray(value.servers) && Object.keys(value.servers).length <= 100,
  'INVALID_MCP_DELEGATION');
  for (const server of Object.values(value.servers))
    requireThat(server && typeof server.url === 'string' &&
      ['command', 'args', 'env', 'env_vars', 'oauth', 'auth', 'oauth_resource',
        'env_http_headers', 'bearer_token_env_var']
        .every(key => !Object.hasOwn(server, key)), 'INVALID_MCP_DELEGATION');
  requireThat(Array.isArray(value.diagnostics) && value.diagnostics.length <= 200 &&
    value.diagnostics.every(item => item &&
      Object.keys(item).sort().join(',') === 'code,name' &&
      typeof item.name === 'string' && typeof item.code === 'string' &&
      /^[A-Za-z0-9_-]{1,200}$/.test(item.name) &&
      /^[A-Z][A-Z0-9_]{1,99}$/.test(item.code)), 'INVALID_MCP_DELEGATION');
  const profile = inheritUserMcp(value.servers);
  requireThat(profile.metadata.diagnostics.length === 0,
    'INVALID_MCP_DELEGATION');
  profile.expiresAt = value.expiresAt;
  profile.metadata.diagnostics = structuredClone(value.diagnostics);
  Object.assign(profile.metadata, {
    nativeVersion: value.nativeVersion, sourceHash: value.sourceHash,
    delegation: { memberId, issuedAt: value.issuedAt, expiresAt: value.expiresAt,
      sourcePlatform: value.sourcePlatform },
  });
  return bindMcpProfile(profile);
}

export async function readMcpDelegation(path, memberId) {
  requireThat(process.platform === 'linux', 'UNSUPPORTED_MCP_DELEGATION_HOST');
  return validateMcpDelegation(await readPrivateMcpJson(path), memberId);
}
