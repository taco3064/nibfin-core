#!/usr/bin/env node
import { intakeClaudeCredential } from '../src/claude-model-credentials.mjs';
import { requireThat } from '../src/identity.mjs';

try {
  requireThat(process.argv.length === 2, 'CLAUDE_CREDENTIAL_ARGUMENTS_DENIED');
  const result = await intakeClaudeCredential();
  process.stdout.write(JSON.stringify(result) + '\n');
} catch (error) {
  const code = /^CLAUDE_[A-Z_]{1,65}$/.test(error.code ?? '')
    ? error.code : 'CLAUDE_CREDENTIAL_INTAKE_FAILED';
  process.stdout.write(JSON.stringify({ status: 'denied', code }) + '\n');
  process.exitCode = 1;
}
