import { appendFile } from 'node:fs/promises';
import { requireThat } from '../src/identity.mjs';

export async function routingOutput(resolve, keys) {
  try {
    const result = await resolve();
    requireThat(
      result.status === 'resolved' &&
        keys.every(
          (key) => typeof result[key] === 'string' && /^[a-z0-9-]+$/.test(result[key]),
        ),
      'INVALID_ROUTING_OUTPUT',
    );
    await appendFile(
      process.env.GITHUB_OUTPUT,
      keys.map((key) => `${key}=${result[key]}\n`).join(''),
    );
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch {
    process.stderr.write('Wake resolution denied; no stage was admitted.\n');
    process.exitCode = 1;
  }
}
