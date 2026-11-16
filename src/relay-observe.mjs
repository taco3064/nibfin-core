import { repoPath } from './github-read.mjs';
import { isId, isSha, requireThat } from './identity.mjs';
import { readCallerContinuity, readCallerSource } from './caller-source.mjs';
import { relayBounds } from './relay-http.mjs';
import { managedWakeArtifactName } from './managed-wake.mjs';

export async function observeRelayOrigin(reader, origin, coreCommit) {
  const repo = await reader.repository(origin.repository);
  requireThat(repo.id === origin.repositoryId && repo.full_name === origin.repository &&
    repo.private === false && repo.archived === false && repo.disabled === false &&
    repo.default_branch === origin.ref, 'RELAY_ORIGIN_REVOKED');
  const root = repoPath(origin.repository);
  const registered = await reader.get(`${root}/actions/workflows/${origin.workflow.id}`);
  requireThat(registered.id === origin.workflow.id &&
    registered.path === origin.workflow.path && registered.state === 'active',
  'RELAY_ORIGIN_WORKFLOW_CHANGED');
  const branch = await reader.get(`${root}/branches/${encodeURIComponent(origin.ref)}`);
  await readCallerContinuity(reader, origin.repository, origin.workflow,
    branch.commit?.sha);
  await readCallerSource(reader, origin.repository, origin.workflow, branch.commit.sha,
    { kind: 'issue-managed', coreCommit });
  return repo;
}

export async function observeRelayAttempt(reader, origin, runId, coreCommit) {
  requireThat(isId(runId), 'INVALID_RELAY_ORIGIN');
  // Never infer the original outcome from a later run/rerun's current status.
  const run = await reader.get(
    `${repoPath(origin.repository)}/actions/runs/${runId}/attempts/1`);
  const reference = run.referenced_workflows?.[0];
  requireThat(run.id === runId && run.run_attempt === 1 && run.event === 'issues' &&
    run.status === 'completed' && run.conclusion === 'success' &&
    run.workflow_id === origin.workflow.id && run.path === origin.workflow.path &&
    run.head_branch === origin.ref && run.repository?.id === origin.repositoryId &&
    run.repository.full_name === origin.repository &&
    run.head_repository?.id === origin.repositoryId && isSha(run.head_sha) &&
    isId(run.actor?.id) && run.actor.id === run.triggering_actor?.id &&
    Array.isArray(run.referenced_workflows) && run.referenced_workflows.length === 1 &&
    reference.path === 'taco3064/nibfin-core/.github/workflows/issue.yml@' + coreCommit &&
    reference.sha === coreCommit, 'RELAY_ORIGINAL_NOT_ELIGIBLE');
  await readCallerContinuity(reader, origin.repository, origin.workflow, run.head_sha);
  await readCallerSource(reader, origin.repository, origin.workflow, run.head_sha,
    { kind: 'issue-managed', coreCommit });
  return run;
}

export async function observeRelayArtifact(reader, origin, run) {
  const root = repoPath(origin.repository);
  const artifacts = await reader.list(`${root}/actions/runs/${run.id}/artifacts`,
    'artifacts');
  const matching = artifacts.filter(item => item.name === managedWakeArtifactName(1));
  requireThat(matching.length <= 1, 'RELAY_AMBIGUOUS_ARTIFACT');
  // The completed authenticated run and a complete fresh listing establish deletion.
  if (!matching.length) return { expired: true };
  const artifact = await reader.get(`${root}/actions/artifacts/${matching[0].id}`);
  const owner = artifact.workflow_run;
  const created = Date.parse(artifact.created_at);
  const updated = Date.parse(artifact.updated_at);
  const started = Date.parse(run.run_started_at), ended = Date.parse(run.updated_at);
  requireThat(isId(artifact.id) && artifact.id === matching[0].id &&
    artifact.name === managedWakeArtifactName(1) &&
    owner?.id === run.id && owner.repository_id === origin.repositoryId &&
    owner.head_repository_id === origin.repositoryId && owner.head_sha === run.head_sha &&
    owner.head_branch === origin.ref &&
    Number.isFinite(created) && Number.isFinite(updated) &&
    created >= started && updated >= created && updated <= ended &&
    typeof artifact.expired === 'boolean', 'RELAY_ARTIFACT_OWNERSHIP_CHANGED');
  if (artifact.expired) return { expired: true };
  requireThat(/^sha256:[a-f0-9]{64}$/.test(artifact.digest ?? '') &&
    Number.isSafeInteger(artifact.size_in_bytes) && artifact.size_in_bytes > 0 &&
    artifact.size_in_bytes <= 65536, 'RELAY_INVALID_ARTIFACT_METADATA');
  return artifact;
}

export function relayRunMatches(run, intent) {
  const { destination: dest, actor, issue } = intent;
  return isId(run?.id) && run.event === 'workflow_dispatch' && run.run_attempt === 1 &&
    run.repository?.id === dest.repositoryId &&
    run.repository.full_name === dest.repository &&
    run.head_repository?.id === dest.repositoryId && run.actor?.id === actor.id &&
    run.actor.login === actor.login && run.triggering_actor?.id === actor.id &&
    run.workflow_id === dest.id && run.path === dest.path &&
    run.head_sha === dest.commit && run.head_branch === dest.ref &&
    run.display_title === `Nibfin ${issue.repositoryId} #${issue.number} wake` &&
    Number.isFinite(Date.parse(run.created_at)) &&
    Date.parse(run.created_at) >= Date.parse(intent.createdAt) &&
    Date.parse(run.created_at) <= Date.parse(intent.createdAt) + relayBounds.timeout;
}

export async function reconcileRelayRun(reader, intent, runId) {
  // Native listings expose the Issue title, not the origin run/attempt or inputs.
  // Even one exact Issue match cannot attribute a lost POST to this origin.
  requireThat(isId(runId), 'RELAY_RUN_READBACK_UNKNOWN');
  const root = repoPath(intent.destination.repository);
  const run = await reader.get(`${root}/actions/runs/${runId}`);
  requireThat(run.id === runId && relayRunMatches(run, intent),
    'RELAY_RUN_READBACK_UNKNOWN');
  return runId;
}
