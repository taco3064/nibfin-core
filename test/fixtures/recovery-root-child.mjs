import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { recoveryFixtureRoot } from '../recovery-fixture-root.mjs';

const callbacks = [];
try {
  const selected = process.argv[2];
  const fixture = await recoveryFixtureRoot({ after: fn => callbacks.push(fn) },
    selected ? { base: selected } : {});
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { mkdtemp, rm, writeFile } from 'node:fs/promises';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    const root = await mkdtemp(join(tmpdir(), 'grandchild-'));
    try {
      await writeFile(join(root, 'output'), 'child output');
      console.log(JSON.stringify({ root, temporary: tmpdir() }));
    } finally { await rm(root, { recursive: true }); }
  `], { encoding: 'utf8', env: fixture.environment });
  if (child.status !== 0) throw new Error(child.stderr);
  const output = join(fixture.root, 'parent-output');
  await writeFile(output, 'parent output');
  console.log(JSON.stringify({ root: fixture.root, output,
    temporary: tmpdir(), child: JSON.parse(child.stdout) }));
} catch (error) {
  console.log(JSON.stringify({ code: error.code, cause: error.cause?.code }));
  process.exitCode = 1;
} finally {
  for (const callback of callbacks.reverse()) await callback();
}
