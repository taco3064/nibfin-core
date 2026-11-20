import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { containsCredentials } from './credential-output.mjs';
import { requireThat } from './identity.mjs';

// Interrupted runs may not have produced either file. Existing output is still
// private and must pass the same credential boundary before consumer retirement.
export async function scanInterruptedOutput(output, secrets, code) {
  const outputs = [['result.json', 1024 * 1024], ['stream.json', 16 * 1024 * 1024]];
  for (const [name, limit] of outputs) {
    let file;
    try {
      file = await open(join(output, name), constants.O_RDONLY | constants.O_NOFOLLOW);
    }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    try {
      const stat = await file.stat();
      requireThat(stat.isFile() && stat.nlink === 1 && stat.size <= limit,
        'UNSAFE_AGENT_OUTPUT');
      const bytes = await file.readFile('utf8');
      requireThat(Buffer.byteLength(bytes) <= limit, 'UNSAFE_AGENT_OUTPUT');
      requireThat(!containsCredentials(bytes, secrets), code);
      if (name === 'stream.json') {
        let stream;
        try { stream = JSON.parse(bytes); }
        catch { requireThat(false, 'UNSAFE_AGENT_OUTPUT'); }
        requireThat(typeof stream.stdout === 'string' &&
          typeof stream.stderr === 'string', 'UNSAFE_AGENT_OUTPUT');
        requireThat(!containsCredentials(stream.stdout, secrets) &&
          !containsCredentials(stream.stderr, secrets), code);
      }
    } finally { await file.close(); }
  }
}
