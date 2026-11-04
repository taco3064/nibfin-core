import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';

const fixture = fileURLToPath(new URL('./process-liveness-fixture.mjs', import.meta.url));

for (const mode of ['leader', 'overflow']) {
  test(
    `bounded caller exits with ${mode} surviving ordinary close`,
    {
      skip: process.platform !== 'linux',
    },
    async (t) => {
      const root = await mkdtemp(join(tmpdir(), 'nibfin-process-liveness-'));
      const record = join(root, 'process.json');
      t.after(async () => {
        const proof = await readFile(record, 'utf8').catch((error) => {
          if (error.code !== 'ENOENT') throw error;
        });
        if (proof) {
          const { pid, startTime } = JSON.parse(proof);
          try {
            const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
            const actual = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
            assert.equal(actual, startTime);
            const state = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0];
            if (state !== 'Z') {
              const argv = (await readFile(`/proc/${pid}/cmdline`))
                .toString()
                .split('\0');
              assert.ok(argv.includes(fixture));
              process.kill(pid, 'SIGKILL');
              let stopped = false;
              for (let attempt = 0; attempt < 20; attempt++) {
                const live = await readFile(`/proc/${pid}/stat`, 'utf8').catch(
                  (error) => {
                    if (error.code !== 'ENOENT') throw error;
                  },
                );
                if (!live || live.slice(live.lastIndexOf(')') + 2).startsWith('Z ')) {
                  stopped = true;
                  break;
                }
                await pause(25);
              }
              assert.equal(stopped, true, 'Synthetic child cleanup is unresolved');
            }
          } catch (error) {
            if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error;
          }
        }
        await rm(root, { recursive: true, force: true });
      });
      // An independent deadline checks actual caller exit, not just Promise.race.
      const result = await promisify(execFile)(
        process.execPath,
        [fixture, 'caller', record, mode],
        { env: {}, timeout: 6000 },
      );
      assert.deepEqual(JSON.parse(result.stdout), {
        code: mode === 'leader' ? 'PROCESS_TIMEOUT' : 'PROCESS_OUTPUT_LIMIT',
        partialOutputExposed: false,
      });
      assert.equal(result.stderr, '');
    },
  );
}
