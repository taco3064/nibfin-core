import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { requireThat, sha256 } from './identity.mjs';
import { rootOwnedPath } from './host-paths.mjs';
import { verifyMcpPath, readPrivateMcpJson } from './mcp-files.mjs';
import { resolveUserMcp } from './mcp-resolve.mjs';
import { createMcpDelegation, validateMcpDelegation } from './mcp-delegation.mjs';

export async function storePrivateMcpDelegation(path, value) {
  validateMcpDelegation(value, value.memberId);
  const target = resolve(path);
  await verifyMcpPath(dirname(target), { directory: true });
  const bytes = Buffer.from(JSON.stringify(value));
  requireThat(bytes.length <= 1024 * 1024, 'MCP_DELEGATION_TOO_LARGE');
  const file = await open(target, constants.O_WRONLY | constants.O_CREAT |
    constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(bytes); await file.sync(); }
  finally { await file.close(); }
  // Read the actual persisted private file; do not report a planned transfer.
  const actual = await readPrivateMcpJson(target);
  requireThat(sha256(Buffer.from(JSON.stringify(actual))) === sha256(bytes),
    'MCP_DELEGATION_WRITE_UNVERIFIED');
  if (process.platform === 'linux') {
    const directory = await open(dirname(target), constants.O_RDONLY |
      constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await directory.sync(); } finally { await directory.close(); }
  }
  return {
    status: 'stored', hash: sha256(bytes), memberId: value.memberId,
    issuedAt: value.issuedAt, expiresAt: value.expiresAt,
    sourcePlatform: value.sourcePlatform, sourceHash: value.sourceHash,
    servers: Object.keys(value.servers), diagnostics: value.diagnostics,
  };
}

// Owner-operated bootstrap only. The result contains metadata, never the bytes
// to be transferred. Original settings remain SSOT; authentication may live in
// the dedicated private native home approved during first OAuth enrollment.
export async function exportUserMcp({
  codex, home, authenticationHome, memberId, output,
}) {
  requireThat(['win32', 'linux'].includes(process.platform),
    'UNSUPPORTED_MCP_EXPORT_HOST');
  if (process.platform === 'linux') await rootOwnedPath(codex);
  else await verifyMcpPath(codex, { privateAccess: false });
  await verifyMcpPath(home, { directory: true, privateAccess: false });
  await verifyMcpPath(join(home, 'config.toml'), { privateAccess: false });
  await verifyMcpPath(authenticationHome, { directory: true });
  const credentials = await readPrivateMcpJson(
    join(authenticationHome, '.credentials.json'));
  const profile = await resolveUserMcp({ codex, home }, {
    credentials,
    validateSystemFile: process.platform === 'linux' ? rootOwnedPath :
      path => verifyMcpPath(path, { privateAccess: false }),
  });
  requireThat(Object.values(profile.configuration.mcp_servers)
    .some(server => server.enabled !== false), 'USER_MCP_NO_USABLE_SERVERS');
  return storePrivateMcpDelegation(output, createMcpDelegation(profile, memberId));
}

// Transport stdin must be the approved private pipe, not an Issue/Workflow input.
// Installing data does not adopt it: trusted host configuration must separately
// select this private file, and native admission supplies the expected member.
export async function importUserMcp(stream, memberId, output) {
  requireThat(process.platform === 'linux' && process.getuid() > 0,
    'UNSUPPORTED_MCP_DELEGATION_HOST');
  const parts = [];
  let size = 0;
  for await (const bytes of stream) {
    size += bytes.length;
    requireThat(size <= 1024 * 1024, 'MCP_DELEGATION_TOO_LARGE');
    parts.push(Buffer.from(bytes));
  }
  const value = JSON.parse(Buffer.concat(parts).toString('utf8'));
  validateMcpDelegation(value, memberId);
  return storePrivateMcpDelegation(output, value);
}
