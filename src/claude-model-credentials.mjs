import { lstat, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { coreRoot, hostFile, boundedHostFile } from './host-adoption.mjs';
import { rootOwnedPath } from './host-paths.mjs';
import { isId, requireThat } from './identity.mjs';
import { verifyInstalledSource } from './source-package.mjs';
import { privateCredentialPipe } from './managed-credential-input.mjs';
import { managedBase, privateResource, publishPrivate, readPrivate }
  from './managed-credential-files.mjs';

import { claudeCredentialKind, claudeCredentialKinds }
  from './claude-credential-kinds.mjs';

export { claudeCredentialKind, claudeCredentialKinds, validClaudeCredential }
  from './claude-credential-kinds.mjs';

const credentials = join(managedBase, 'credentials');
// The fixed managed path of each kind's one stored file.
const kindFiles = (directory = credentials) => Object.fromEntries(
  Object.entries(claudeCredentialKinds)
    .map(([kind, { name }]) => [kind, join(directory, name)]));
export const claudeApiKeyFile = kindFiles()['anthropic-api-key'];

const absent = path => lstat(path).then(() => false, error => {
  if (error.code === 'ENOENT') return true;
  throw new Error('CLAUDE_CREDENTIAL_UNAVAILABLE');
});

// Returns the one stored value. `files` relocates the fixed paths for tests only.
export async function readClaudeCredential(uid = process.getuid(), files) {
  const found = [];
  for (const [kind, fixed] of Object.entries(kindFiles())) {
    const file = files?.[kind] ?? fixed;
    if (await absent(file)) continue;
    const value = (await readPrivate(file, { uid }, 1024).catch(() => null))?.trim();
    requireThat(claudeCredentialKind(value) === kind, 'CLAUDE_CREDENTIAL_UNAVAILABLE');
    found.push(value);
  }
  requireThat(found.length === 1, 'CLAUDE_CREDENTIAL_UNAVAILABLE');
  return found[0];
}

export async function intakeClaudeCredential(input = process.stdin) {
  requireThat(process.platform === 'linux' && process.getuid() === 0 &&
    coreRoot === '/opt/nibfin/core', 'CLAUDE_CREDENTIAL_REQUIRES_ADMIN');
  privateCredentialPipe();
  await rootOwnedPath(hostFile);
  const host = JSON.parse(await boundedHostFile(hostFile, 262144));
  requireThat(isId(host.uid) && host.installation?.directory === coreRoot,
    'CLAUDE_CREDENTIAL_INVALID_HOST');
  await verifyInstalledSource(coreRoot, host.installation.pin);
  return storeClaudeCredential(input, credentials, host.uid);
}

// Stores one value in a private credential directory owned by `uid`. Production
// reaches it only through the verified-host intake above; tests pass a fixture.
export async function storeClaudeCredential(input, directory, uid) {
  const { gid } = await privateResource(directory, uid, true);
  const files = kindFiles(directory);
  const lockFile = join(directory, '.claude-intake.lock');
  // The operation is exclusive and never replaces or adds a second credential.
  const lock = await open(lockFile, 'wx', 0o600);
  const chunks = [];
  const timer = setTimeout(
    () => input.destroy(new Error('CLAUDE_CREDENTIAL_UNAVAILABLE')), 10000);
  try {
    for (const file of Object.values(files))
      requireThat(await absent(file), 'CLAUDE_CREDENTIAL_EXISTS');
    let size = 0;
    for await (const chunk of input) {
      size += chunk.length;
      requireThat(size <= 1024, 'CLAUDE_CREDENTIAL_UNAVAILABLE');
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    let credentialKind;
    try {
      credentialKind = claudeCredentialKind(bytes.toString().trim());
      requireThat(credentialKind, 'CLAUDE_CREDENTIAL_UNAVAILABLE');
      await publishPrivate(files[credentialKind], bytes, { uid, gid });
    } finally { bytes.fill(0); }
    return { status: 'stored', credentialKind };
  } finally {
    clearTimeout(timer);
    for (const chunk of chunks) chunk.fill(0);
    await lock.close();
    await unlink(lockFile);
  }
}
