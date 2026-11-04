// Synthetic local processes only; no native provider, credentials or sockets.
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { command } from '../src/process.mjs';

const ownPath = fileURLToPath(import.meta.url);
const [mode, record, target] = process.argv.slice(2);

async function main() {
  if (mode === 'caller') {
    try {
      await command(process.execPath, [ownPath, target, record], {
        timeout: 2000,
        limit: target === 'overflow' ? 32 : 1024,
      });
      process.stdout.write('{"code":"UNEXPECTED_SUCCESS"}');
    } catch (error) {
      process.stdout.write(
        JSON.stringify({
          code: error.code,
          partialOutputExposed: Object.hasOwn(error, 'stdout'),
        }),
      );
    }
    return;
  }
  if (mode === 'leader') {
    const child = spawn(process.execPath, [ownPath, 'retainer', record], {
      env: {},
      detached: true,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.unref();
    setInterval(() => {}, 1000);
    return;
  }
  if (mode === 'retainer' || mode === 'overflow') {
    process.on('SIGTERM', () => {});
    const stat = await readFile('/proc/self/stat', 'utf8');
    await writeFile(
      record,
      JSON.stringify({
        pid: process.pid,
        startTime: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19],
      }),
      { flag: 'wx', mode: 0o600 },
    );
    if (mode === 'overflow') process.stdout.write('synthetic'.repeat(1024));
    setInterval(() => {}, 1000);
    return;
  }
  throw new Error('Unknown synthetic process mode');
}

await main();
