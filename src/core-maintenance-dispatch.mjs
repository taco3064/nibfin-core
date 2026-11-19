import { isId, isSha, requireThat } from './identity.mjs';
import { repoPath } from './github-read.mjs';

const repository = 'taco3064/nibfin-core';
const workflow = '.github/workflows/core-maintenance.yml';

// A completed producer event locates one operation. It never discovers "latest".
export async function maintenanceTarget(reader, runId) {
  requireThat(isId(runId), 'CORE_MAINTENANCE_CD_RUN_REQUIRED');
  const root = repoPath(repository);
  const [repo, run, producer] = await Promise.all([
    reader.get(root), reader.get(`${root}/actions/runs/${runId}`),
    reader.get(`${root}/actions/workflows/cd.yml`),
  ]);
  requireThat(repo.full_name === repository && isId(repo.id) &&
    repo.default_branch === 'main' && repo.private === false &&
    repo.archived === false && repo.disabled === false &&
    run.id === runId && run.repository?.id === repo.id &&
    run.head_repository?.id === repo.id && run.head_branch === repo.default_branch &&
    isSha(run.head_sha) && run.path === '.github/workflows/cd.yml' &&
    ['workflow_run', 'workflow_dispatch'].includes(run.event) &&
    run.workflow_id === producer.id && producer.path === '.github/workflows/cd.yml' &&
    producer.state === 'active' && run.status === 'completed' &&
    run.conclusion === 'success', 'CORE_MAINTENANCE_CD_RUN_UNTRUSTED');
  const records = await reader.list(`${root}/actions/runs/${runId}/artifacts`,
    'artifacts');
  const matches = records.filter(item =>
    /^nibfin-activate-[a-f0-9]{40}$/.test(item.name ?? '') && item.expired === false);
  // Docs-only and a CD still awaiting its consumer result have no activation.
  if (matches.length === 0) return { status: 'unavailable', runId };
  requireThat(matches.length === 1 && isId(matches[0].id) &&
    matches[0].workflow_run?.id === runId, 'CORE_MAINTENANCE_CD_TARGET_AMBIGUOUS');
  return { status: 'ready', runId, artifactId: matches[0].id,
    repository, ref: repo.default_branch, workflow };
}

export async function dispatchMaintenance(reader, runId, dispatch) {
  const target = await maintenanceTarget(reader, runId);
  if (target.status !== 'ready') return target;
  const maintenance = await dispatch(target);
  return { status: 'dispatched', cdRunId: runId, artifactId: target.artifactId,
    maintenance };
}
