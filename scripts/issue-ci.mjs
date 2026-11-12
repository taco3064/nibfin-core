import { runIssueWake } from '../src/issue-wake.mjs';
import { routingOutput } from './routing-output.mjs';
import { forwardSharedWake } from '../src/shared-wake.mjs';

await routingOutput(async () => {
  const result = await runIssueWake();
  if (process.env.NIBFIN_SHARED_RUNNER_POOL === 'true')
    await forwardSharedWake(result, process.env);
  return result;
}, ['issue_number', 'member_id']);
