import { runIssueWake } from '../src/issue-wake.mjs';
import { routingOutput } from './routing-output.mjs';

await routingOutput(runIssueWake, ['issue_number', 'member_id']);
