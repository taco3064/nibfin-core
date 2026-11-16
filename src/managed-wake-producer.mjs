import { readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  managedWakeArtifactName, managedWakeContract, projectManagedWake, serializeManagedWake,
} from './managed-wake.mjs';
import { requireThat } from './identity.mjs';

// The fixed hosted workflow uploads only this file with upload-artifact.
// Producing a file does not claim that an upload or downstream wake succeeded.
export async function produceManagedWake(env = process.env) {
  const directory = join(env.RUNNER_TEMP, 'nibfin-issue-wake');
  const path = join(directory, managedWakeContract.fileName);
  await mkdir(directory, { recursive: true });
  await rm(path, { force: true });
  const bytes = await readFile(env.GITHUB_EVENT_PATH);
  requireThat(bytes.length <= 1048576, 'WAKE_EVENT_TOO_LARGE');
  const projected = projectManagedWake(JSON.parse(bytes), {
    eventName: env.GITHUB_EVENT_NAME, repository: env.GITHUB_REPOSITORY,
    runId: Number(env.GITHUB_RUN_ID), attempt: Number(env.GITHUB_RUN_ATTEMPT),
  });
  await writeFile(path, serializeManagedWake(projected), { flag: 'wx', mode: 0o600 });
  return { path, artifactName: managedWakeArtifactName(projected.attempt) };
}
