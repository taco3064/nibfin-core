import { lstat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { requireThat } from './identity.mjs';
import { managedPaths, readPrivate } from './managed-credential-files.mjs';
import { claudeCredentialFile } from './managed-credential-set.mjs';

import { claudeCredentialKind, claudeCredentialKinds }
  from './claude-credential-kinds.mjs';

export { claudeCredentialKind, claudeCredentialKinds, validClaudeCredential }
  from './claude-credential-kinds.mjs';

// Managed credential intake stores the one file; this module only reads it.
const credentials = dirname(managedPaths.tokenFile);
// The fixed managed path of each kind's one stored file.
const kindFiles = () => Object.fromEntries(Object.keys(claudeCredentialKinds)
  .map(kind => [kind, claudeCredentialFile(credentials, kind)]));

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
