import { readFile } from 'node:fs/promises';
import { GitHubReader } from '../src/github-read.mjs';
import { requireThat } from '../src/identity.mjs';
import { dispatchMaintenance } from '../src/core-maintenance-dispatch.mjs';
import { dispatchNativeWorkflow, workflowDispatchFailure }
  from '../src/native-workflow-dispatch.mjs';
import { rolloutFailure, rolloutResultExit } from '../src/core-rollout-result.mjs';

try {
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
  requireThat(process.env.GITHUB_EVENT_NAME === 'workflow_run' &&
    process.env.GITHUB_REPOSITORY === 'taco3064/nibfin-core' &&
    event.action === 'completed', 'CORE_MAINTENANCE_EVENT_INVALID');
  const reader = new GitHubReader(process.env.GH_TOKEN);
  const result = await dispatchMaintenance(reader, event.workflow_run?.id,
    target => dispatchNativeWorkflow({ ...target, id: 'core-maintenance.yml' }, {
          cd_run_id: String(target.runId),
          activation_artifact_id: String(target.artifactId),
    }, process.env.GH_TOKEN));
  process.stdout.write(JSON.stringify(result) + '\n');
} catch (error) {
  const result = workflowDispatchFailure(error) ?? rolloutFailure(error);
  process.stderr.write(JSON.stringify(result) + '\n');
  process.exitCode = rolloutResultExit(result);
}
