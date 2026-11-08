import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CodexRoleAgent } from '../src/codex-agent.mjs';
import { withUserMcp } from '../src/mcp-agent.mjs';
import { jobMcpProfile } from '../src/mcp-job.mjs';
import { digest } from '../src/identity.mjs';
import { stageFixture } from './stage-fixture.mjs';

for (const leak of [false, true]) {
  test(`model output scanning gates Job-copy retirement; leak=${leak}`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'nibfin-job-agent-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const stateRoot = join(root, 'state'), work = join(root, 'work');
    const authFile = join(root, 'auth.json');
    await mkdir(stateRoot, { mode: 0o700 });
    await mkdir(work, { mode: 0o700 });
    const secret = 'synthetic-only-model-access-token';
    await writeFile(authFile, JSON.stringify({ auth_mode: 'chatgpt', tokens: {
      access_token: secret, refresh_token: secret + '-refresh', id_token: secret + '-id',
    } }), { mode: 0o600 });
    const job = jobMcpProfile(async () => ({ expiresAt: null,
      metadata: {}, policyHash: 'd'.repeat(64), secrets: [],
      configuration: { mcp_servers: {} } }));
    let retired = false;
    const thread = '12345678-1234-4234-8234-123456789abc';
    const isolator = withUserMcp({ execute: async input => {
      const result = { outcome: 'ready', body: 'Synthetic Shape', summary: 'Fixture',
        rootCause: '', failureClass: 'none', evidenceReferences: ['/input/context.json'],
        blockingFindings: [], contractConflicts: [] };
      const text = JSON.stringify(result);
      await writeFile(join(input.output, 'result.json'), text);
      await mkdir(join(input.session, 'sessions'));
      await writeFile(join(input.session, 'sessions', `rollout-${thread}.jsonl`),
        JSON.stringify({ type: 'session_meta', payload: { id: thread } }) + '\n');
      return { status: 'completed', executionId: input.executionId,
        terminationHash: 'a'.repeat(64), isolationHash: 'b'.repeat(64),
        probeHash: 'c'.repeat(64), policyHash: input.plan.policyHash,
        stderr: leak ? secret : '', stdout: [
          { type: 'thread.started', thread_id: thread }, { type: 'turn.started' },
          { type: 'item.completed', item: { type: 'agent_message', text } },
          { type: 'turn.completed' },
        ].map(JSON.stringify).join('\n'),
        retireMcp: async () => { retired = true; },
      };
    } }, {}, () => job.read(), job);
    const coreRoot = resolve(import.meta.dirname, '..');
    const agent = new CodexRoleAgent({ stateRoot, work, authFile, coreRoot,
      model: 'configured-model', skills: {
        shape: digest(await readFile(join(coreRoot, 'skills/shape/SKILL.md'), 'utf8')),
      } }, isolator, { prepareMain: async (directory, _issue, head) => {
      await mkdir(directory, { mode: 0o700 });
      return { base: head, directory };
    } });
    const execution = agent.run('shape', stageFixture('shape'));
    if (leak) {
      await assert.rejects(execution, { code: 'CREDENTIAL_OUTPUT_REJECTED' });
      await assert.rejects(job.retire([], true), {
        code: 'MCP_JOB_TERMINATION_UNPROVEN',
      });
    } else {
      await execution;
      await job.retire([], true);
    }
    assert.equal(retired, !leak);
  });
}
