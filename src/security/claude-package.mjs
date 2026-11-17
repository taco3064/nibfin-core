import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const version = '2.1.326';
const hashes = {
  x64: 'RvNuaeMGfPGUyUGttVvhHgVUZ3B2L+Pgf336ImZLsPP2UQHYblewi47CPFLObqz+' +
    'K6D++PLP1eAsDBLYko3w+g==',
  arm64: 'lZCCWXarB/1IeHkotI937eEdN4BCbVdWDdmejtlkbUO9M29rHjITtXW9BWCDFlxvo' +
    '0GXsFogN0SFIJWgMelKLw==',
};
const platform = process.arch;
if (!Object.hasOwn(hashes, platform)) throw new Error('CLAUDE_PACKAGE_UNAVAILABLE');
const name = `claude-code-linux-${platform}`;
const url = `https://registry.npmjs.org/@anthropic-ai/${name}/-/${name}-${version}.tgz`;
const response = await fetch(url, {
  redirect: 'error', signal: AbortSignal.timeout(90000),
});
if (!response.ok) throw new Error('CLAUDE_PACKAGE_UNAVAILABLE');
const chunks = [];
let length = 0;
for await (const chunk of response.body) {
  length += chunk.length;
  if (length > 192 * 1024 * 1024) throw new Error('CLAUDE_PACKAGE_TOO_LARGE');
  chunks.push(chunk);
}
const data = Buffer.concat(chunks);
if (createHash('sha512').update(data).digest('base64') !== hashes[platform])
  throw new Error('CLAUDE_PACKAGE_INTEGRITY');
const temporary = await mkdtemp(join(tmpdir(), 'claude-package-'));
try {
  const archive = join(temporary, 'claude.tgz');
  const directory = '/opt/nibfin/claude/bin';
  await mkdir(directory, { recursive: true });
  await writeFile(archive, data);
  const extract = spawnSync('/usr/bin/tar', ['-xzf', archive, '-C', directory,
    '--strip-components=1', '--no-same-owner', 'package/claude']);
  const cli = spawnSync(`${directory}/claude`, ['--version'],
    { env: { PATH: '/usr/bin:/bin', HOME: temporary }, encoding: 'utf8' });
  if (extract.status !== 0 || cli.status !== 0 ||
    cli.stdout.trim() !== `${version} (Claude Code)`)
    throw new Error('CLAUDE_PACKAGE_VERSION_UNAVAILABLE');
} finally {
  await rm(temporary, { recursive: true, force: true });
}
