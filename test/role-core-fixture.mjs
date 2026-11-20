import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

// A sibling of the fixture workspace preserves the production non-overlap rule
// when TMPDIR lives inside the repository rather than outside its source tree.
export async function roleCoreFixture(root, skill) {
  const coreRoot = join(root, 'core');
  const directory = join(coreRoot, 'skills', skill);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const source = resolve('skills', skill, 'SKILL.md');
  await writeFile(join(directory, 'SKILL.md'), await readFile(source));
  return coreRoot;
}
