#!/usr/bin/env node
import { runWorkBridge } from '../src/claude-work-bridge.mjs';

try {
  if (process.argv.length !== 2) throw new Error('WORK_ARGUMENTS_DENIED');
  await runWorkBridge(process.stdin, process.stdout);
} catch {
  process.stderr.write('WORK_CHANNEL_UNAVAILABLE\n');
  process.exitCode = 1;
}
