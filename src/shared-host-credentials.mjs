import { lstat, realpath } from 'node:fs/promises';
import { dirname } from 'node:path';
import { requireThat } from './identity.mjs';
import { managedPaths } from './managed-credential-files.mjs';
import { claudeCredentialFile } from './managed-credential-set.mjs';
import { claudeCredentialKinds } from './claude-credential-kinds.mjs';

// The fixed managed credential directory the Claude composition reads.
const managedCredentials = dirname(managedPaths.tokenFile);

export async function privatePath(path, uid, directory = false) {
  requireThat(typeof path === 'string' && await realpath(path) === path,
    'SHARED_HOST_CONTROLLER_RESOURCE_INVALID');
  const stat = await lstat(path);
  requireThat(stat.uid === uid && (stat.mode & 0o077) === 0 &&
    (directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1),
  'SHARED_HOST_CONTROLLER_RESOURCE_INVALID');
}

const present = path => lstat(path).then(() => true, error => {
  if (error.code === 'ENOENT') return false;
  throw error;
});

// Names the one stored Claude kind from which file exists; the secret is never
// read here. Managed intake validated its content; staging checks it again.
async function storedClaudeKind(credentials) {
  const kinds = [];
  for (const kind of Object.keys(claudeCredentialKinds))
    if (await present(claudeCredentialFile(credentials, kind))) kinds.push(kind);
  requireThat(kinds.length === 1, 'SHARED_HOST_CONTROLLER_RESOURCE_INVALID');
  return kinds[0];
}

// Checks the private controller files the profile's provider needs and returns
// the Claude credential kind, or undefined for Codex. Any provider other than
// Claude keeps the original Codex checks; the binding rejects unknown values.
// `credentials` and `check` relocate the fixed directory and file check for tests.
export async function controllerCredentials(profile, uid, {
  credentials = managedCredentials, check = privatePath,
} = {}) {
  const { stateRoot, tokenFile, authFile } = profile;
  const claude = profile.provider === 'claude';
  if (claude) requireThat(dirname(tokenFile) === credentials,
    'SHARED_HOST_PROFILE_INVALID');
  for (const path of [stateRoot, dirname(tokenFile), dirname(authFile)])
    await check(path, uid, true);
  if (!claude) {
    for (const path of [tokenFile, authFile]) await check(path, uid);
    return undefined;
  }
  const kind = await storedClaudeKind(credentials);
  for (const path of [tokenFile, claudeCredentialFile(credentials, kind)])
    await check(path, uid);
  return kind;
}
