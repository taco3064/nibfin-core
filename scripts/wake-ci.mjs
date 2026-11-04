import { runWakeEntry } from '../src/wake-entry.mjs';
import { routingOutput } from './routing-output.mjs';

await routingOutput(runWakeEntry, ['issue_number', 'member_id', 'stage']);
