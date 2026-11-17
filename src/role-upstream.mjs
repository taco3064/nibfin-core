import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readCurrentMain } from './current-main.mjs';
import { repoPath } from './github-read.mjs';
import { requireThat } from './identity.mjs';

// Prerequisites come from native admission, never from a link in the Issue Body.
// Only checked-out source enters /input. Git metadata stays on the Controller.
export async function prepareRoleUpstream({
  context, io, input, reader, core, prepare,
}) {
  if (context.dependencies?.ready !== true) return;
  const issue = context.approval.record.issue;
  const dependencies = new Map();
  for (const dependency of context.dependencies.identities) {
    if (dependency.repositoryId === issue.repositoryId) continue;
    const previous = dependencies.get(dependency.repository);
    requireThat(!previous || previous.repositoryId === dependency.repositoryId,
      'UPSTREAM_REPOSITORY_CHANGED');
    dependencies.set(dependency.repository, dependency);
  }
  if (!dependencies.size) return;
  const inventory = [];
  for (const dependency of dependencies.values()) {
    const { repository } = dependency;
    repoPath(repository);
    const [owner, name] = repository.split('/');
    const scratch = await mkdtemp(join(io, 'upstream-'));
    try {
      let head, snapshot;
      try {
        const main = await readCurrentMain(reader, dependency);
        head = repository === core.repository ? core.commit : main.head;
        snapshot = await prepare(join(scratch, 'source'), dependency, head);
        requireThat(snapshot.base === head, 'UPSTREAM_SOURCE_CHANGED');
      } catch {
        inventory.push({ repository, status: 'unavailable' });
        continue;
      }
      await mkdir(join(input, 'upstream', owner), { recursive: true, mode: 0o700 });
      await rename(snapshot.directory, join(input, 'upstream', owner, name));
      inventory.push({ repository, commit: head, path: `/input/upstream/${repository}` });
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }
  await writeFile(join(input, 'upstream.json'), JSON.stringify(inventory),
    { flag: 'wx', mode: 0o400 });
}
