import { lstat, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { coreRoot, hostFile, boundedHostFile } from './host-adoption.mjs';
import { rootOwnedPath } from './host-paths.mjs';
import { isId, requireThat } from './identity.mjs';
import { verifyInstalledSource } from './source-package.mjs';
import { privateCredentialPipe } from './managed-credential-input.mjs';
import { managedBase, privateResource, publishPrivate, readPrivate }
  from './managed-credential-files.mjs';

const credentials = join(managedBase, 'credentials');
// One pool stores exactly one Claude credential. The subscription token comes
// from the official `claude setup-token`; an API key uses API billing instead.
export const claudeCredentialKinds = Object.freeze({
  'claude-subscription-token': Object.freeze({
    file: join(credentials, 'claude-oauth-token'),
    pattern: /^sk-ant-oat[0-9]{2}-[A-Za-z0-9_-]{20,500}$/,
  }),
  'anthropic-api-key': Object.freeze({
    file: join(credentials, 'anthropic-api-key'),
    pattern: /^sk-ant-api[0-9]{2}-[A-Za-z0-9_-]{20,500}$/,
  }),
});
export const claudeApiKeyFile = claudeCredentialKinds['anthropic-api-key'].file;

export function claudeCredentialKind(value) {
  if (typeof value !== 'string') return undefined;
  return Object.keys(claudeCredentialKinds)
    .find(kind => claudeCredentialKinds[kind].pattern.test(value));
}
export const validClaudeCredential = value =>
  claudeCredentialKind(value) !== undefined;

const absent = path => lstat(path).then(() => false, error => {
  if (error.code === 'ENOENT') return true;
  throw new Error('CLAUDE_CREDENTIAL_UNAVAILABLE');
});

// Returns the one stored value. `files` relocates the fixed paths for tests only.
export async function readClaudeCredential(uid = process.getuid(), files) {
  const found = [];
  for (const [kind, { file: fixed }] of Object.entries(claudeCredentialKinds)) {
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
  const { gid } = await privateResource(credentials, host.uid, true);
  // The operation is exclusive and never replaces or adds a second credential.
  const lock = await open(join(credentials, '.claude-intake.lock'), 'wx', 0o600);
  const chunks = [];
  const timer = setTimeout(
    () => input.destroy(new Error('CLAUDE_CREDENTIAL_UNAVAILABLE')), 10000);
  try {
    for (const { file } of Object.values(claudeCredentialKinds))
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
      await publishPrivate(claudeCredentialKinds[credentialKind].file, bytes,
        { uid: host.uid, gid });
    } finally { bytes.fill(0); }
    return { status: 'stored', credentialKind };
  } finally {
    clearTimeout(timer);
    for (const chunk of chunks) chunk.fill(0);
    await lock.close();
    await unlink(join(credentials, '.claude-intake.lock'));
  }
}
