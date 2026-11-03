import { appendFile } from 'node:fs/promises';
import { runWakeEntry } from '../src/wake-entry.mjs';

try {
  const result = await runWakeEntry();
  await appendFile(process.env.GITHUB_OUTPUT,
    `issue_number=${result.issue_number}\nmember_id=${result.member_id}\nstage=${result.stage}\n`);
  process.stdout.write(JSON.stringify(result) + '\n');
} catch {
  process.stderr.write('Wake resolution denied; no stage was admitted.\n');
  process.exitCode = 1;
}
