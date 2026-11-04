import { readFile } from 'node:fs/promises';
import { GitHubReader, repoPath } from './github-read.mjs';
import { observeWake } from './wakeup.mjs';
import { digest, isId, isSha, requireThat } from './identity.mjs';
import { readCallerSource } from './caller-source.mjs';

// Adoption is supplied by the protected caller's administrator, never dispatch
// inputs. A dispatch supplies only a locator; all routing is freshly resolved.
export async function resolveWakeDispatch(
  reader,
  adoption,
  event,
  invocation,
  clock = Date.now,
) {
  const inputs = event?.inputs;
  requireThat(
    inputs &&
      Object.keys(inputs).sort().join(',') === 'issue_id,issue_number,repository_id' &&
      /^[1-9][0-9]*$/.test(inputs.issue_number) &&
      isId(Number(inputs.issue_number)) &&
      /^[1-9][0-9]*$/.test(inputs.repository_id) &&
      isId(Number(inputs.repository_id)) &&
      typeof inputs.issue_id === 'string' &&
      inputs.issue_id.length > 0,
    'INVALID_WAKE_LOCATOR',
  );
  requireThat(
    adoption?.schemaVersion === 1 &&
      isSha(adoption.coreCommit) &&
      adoption.coreCommit === invocation?.coreCommit &&
      Array.isArray(adoption.issues),
    'INVALID_WAKE_ADOPTION',
  );
  const matches = adoption.issues.filter(
    (item) =>
      item.approvalPin?.issueId === inputs.issue_id &&
      item.approvalPin.repositoryId === Number(inputs.repository_id),
  );
  requireThat(matches.length === 1, 'WAKE_ISSUE_NOT_ADOPTED');
  const selected = matches[0],
    pin = selected.approvalPin;
  requireThat(
    pin.source?.repository === 'taco3064/nibfin-core' &&
      pin.source.commit === adoption.coreCommit &&
      event.repository?.id === pin.repositoryId &&
      event.repository.full_name === pin.repository &&
      invocation.repository === pin.repository &&
      invocation.eventName === 'workflow_dispatch' &&
      isId(invocation.runId) &&
      isId(invocation.attempt),
    'WAKE_CALLER_MISMATCH',
  );
  const path = `${repoPath(pin.repository)}/actions/runs/${invocation.runId}`;
  const readCaller = async () => {
    const run = await reader.get(path);
    requireThat(
      run.id === invocation.runId &&
        run.run_attempt === invocation.attempt &&
        run.event === 'workflow_dispatch' &&
        run.status === 'in_progress' &&
        run.workflow_id === selected.workflow.id &&
        run.path === selected.workflow.path &&
        run.head_branch === event.repository.default_branch &&
        run.repository?.id === pin.repositoryId &&
        run.head_repository?.id === pin.repositoryId &&
        run.actor?.id === selected.actorId &&
        run.triggering_actor?.id === selected.actorId &&
        Array.isArray(run.referenced_workflows) &&
        run.referenced_workflows.length >= 1 &&
        run.referenced_workflows.length <= 2 &&
        new Set(run.referenced_workflows.map((workflow) => workflow.path)).size ===
          run.referenced_workflows.length &&
        run.referenced_workflows.every(
          (workflow) =>
            ['wake', 'stage'].some(
              (name) =>
                workflow.path ===
                'taco3064/nibfin-core/.github/workflows/' +
                  `${name}.yml@${adoption.coreCommit}`,
            ) && workflow.sha === adoption.coreCommit,
        ) &&
        run.referenced_workflows.some(
          (workflow) =>
            workflow.path ===
            `taco3064/nibfin-core/.github/workflows/wake.yml@${adoption.coreCommit}`,
        ),
      'UNTRUSTED_WAKE_CALLER',
    );
    await readCallerSource(reader, pin.repository, selected.workflow, run.head_sha, {
      kind: 'wake',
      coreCommit: adoption.coreCommit,
    });
    return digest({
      id: run.id,
      attempt: run.run_attempt,
      source: run.head_sha,
      actor: run.actor.id,
      workflow: run.workflow_id,
      path: run.path,
    });
  };
  const caller = await readCaller();
  const wake = await observeWake(reader, selected, clock);
  requireThat(
    wake.issue.number === Number(inputs.issue_number),
    'WAKE_ISSUE_NUMBER_CHANGED',
  );
  requireThat((await readCaller()) === caller, 'WAKE_CALLER_CHANGED');
  return {
    status: 'resolved',
    issue_number: String(wake.issue.number),
    member_id: String(wake.route.userId),
    stage: wake.entryStage,
    stageAdmitted: false,
  };
}

export async function runWakeEntry(env = process.env) {
  requireThat(
    typeof env.NIBFIN_WAKE_ADOPTION === 'string' &&
      env.NIBFIN_WAKE_ADOPTION.length <= 256 * 1024 &&
      typeof env.NIBFIN_READ_TOKEN === 'string' &&
      env.NIBFIN_READ_TOKEN.trim() &&
      typeof env.GITHUB_EVENT_PATH === 'string',
    'WAKE_CONFIGURATION_REQUIRED',
  );
  const event = await readFile(env.GITHUB_EVENT_PATH, 'utf8');
  requireThat(Buffer.byteLength(event) <= 1024 * 1024, 'WAKE_EVENT_TOO_LARGE');
  return resolveWakeDispatch(
    new GitHubReader(env.NIBFIN_READ_TOKEN),
    JSON.parse(env.NIBFIN_WAKE_ADOPTION),
    JSON.parse(event),
    {
      repository: env.GITHUB_REPOSITORY,
      eventName: env.GITHUB_EVENT_NAME,
      runId: Number(env.GITHUB_RUN_ID),
      attempt: Number(env.GITHUB_RUN_ATTEMPT),
      coreCommit: env.NIBFIN_CORE_COMMIT,
    },
  );
}
