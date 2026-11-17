import { open, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { coreRoot, hostFile, boundedHostFile } from './host-adoption.mjs';
import { rootOwnedPath } from './host-paths.mjs';
import { isId, requireThat } from './identity.mjs';
import { verifyInstalledSource } from './source-package.mjs';
import { privateCredentialPipe } from './managed-credential-input.mjs';
import { managedBase, privateResource, publishPrivate, readPrivate }
  from './managed-credential-files.mjs';

export const claudeApiKeyFile = join(managedBase, 'credentials/anthropic-api-key');
export const validClaudeApiKey = value =>
  typeof value === 'string' && /^sk-ant-[a-zA-Z0-9_-]{20,500}$/.test(value);

export async function readClaudeApiKey() {
  const value = await readPrivate(claudeApiKeyFile, { uid: process.getuid() }, 1024)
    .catch(() => null);
  const key = value?.trim();
  requireThat(validClaudeApiKey(key), 'CLAUDE_API_KEY_UNAVAILABLE');
  return key;
}

export async function intakeClaudeApiKey(input = process.stdin) {
  requireThat(process.platform === 'linux' && process.getuid() === 0 &&
    coreRoot === '/opt/nibfin/core', 'CLAUDE_CREDENTIAL_REQUIRES_ADMIN');
  privateCredentialPipe();
  await rootOwnedPath(hostFile);
  const host = JSON.parse(await boundedHostFile(hostFile, 262144));
  requireThat(isId(host.uid) && host.installation?.directory === coreRoot,
    'CLAUDE_CREDENTIAL_INVALID_HOST');
  await verifyInstalledSource(coreRoot, host.installation.pin);
  const directory = dirname(claudeApiKeyFile);
  const { gid } = await privateResource(directory, host.uid, true);
  // The operation is exclusive and never replaces an existing credential.
  const lock = await open(join(directory, '.claude-intake.lock'), 'wx', 0o600);
  const chunks = [];
  const timer = setTimeout(() => input.destroy(new Error('CLAUDE_API_KEY_UNAVAILABLE')),
    10000);
  try {
    let size = 0;
    for await (const chunk of input) {
      size += chunk.length;
      requireThat(size <= 1024, 'CLAUDE_API_KEY_UNAVAILABLE');
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    try {
      requireThat(validClaudeApiKey(bytes.toString().trim()),
        'CLAUDE_API_KEY_UNAVAILABLE');
      await publishPrivate(claudeApiKeyFile, bytes, { uid: host.uid, gid });
    } finally { bytes.fill(0); }
    return { status: 'stored', credentialKind: 'anthropic-api-key' };
  } finally {
    clearTimeout(timer);
    for (const chunk of chunks) chunk.fill(0);
    await lock.close();
    await unlink(join(directory, '.claude-intake.lock'));
  }
}
