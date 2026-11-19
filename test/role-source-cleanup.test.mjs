import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, access, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { CodexRoleAgent } from '../src/codex-agent.mjs';
import { stageFixture } from './stage-fixture.mjs';
import { discardRoleSources } from '../src/role-source-cleanup.mjs';
import { digest } from '../src/identity.mjs';

const linux = { skip: process.platform !== 'linux' };

async function fixture(t, status) {
  const scratch = resolve('.npm');
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'role-cleanup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateRoot = join(root, 'state');
  const work = join(root, 'work');
  const authFile = join(root, 'auth.json');
  await mkdir(stateRoot, { mode: 0o700 });
  await mkdir(work, { mode: 0o700 });
  await writeFile(join(work, 'implementation.txt'), 'preserve implementation');
  await writeFile(authFile, JSON.stringify({ auth_mode: 'chatgpt', tokens: {
    access_token: 'synthetic-access-token-with-no-authority',
    refresh_token: 'synthetic-refresh-token-with-no-authority',
    id_token: 'synthetic-identity-token-with-no-authority',
  } }), { mode: 0o600 });
  const thread = '12345678-1234-4234-8234-123456789abc';
  const context = stageFixture('shape');
  const io = join(stateRoot, `execution-${context.execution.id}`);
  const sources = join(io, 'current-main');
  const upstream = join(io, 'input', 'upstream');
  const resultPath = join(io, 'output', 'result.json');
  const isolator = { execute: async input => {
    await mkdir(upstream);
    await writeFile(join(upstream, 'dependency.txt'), 're-fetchable upstream');
    const message = JSON.stringify({ outcome: 'ready', body: 'Synthetic Shape',
      summary: 'Checked fixture', rootCause: '', failureClass: 'none',
      evidenceReferences: ['/input/context.json'], blockingFindings: [],
      contractConflicts: [] });
    await writeFile(resultPath, message);
    return { status, executionId: input.executionId,
      terminationHash: status === 'pending' ? undefined : 'a'.repeat(64),
      policyHash: input.plan.policyHash, isolationHash: 'b'.repeat(64),
      probeHash: 'c'.repeat(64), stderr: '', stdout: [
        { type: 'thread.started', thread_id: thread },
        { type: 'turn.started' },
        { type: 'item.completed', item: { type: 'agent_message', text: message } },
        { type: 'turn.completed' },
      ].map(JSON.stringify).join('\n') };
  } };
  const agent = new CodexRoleAgent({ stateRoot, work, authFile,
    coreRoot: resolve('.'), model: 'configured-model', skills: {
      shape: digest(await readFile('skills/shape/SKILL.md', 'utf8')),
    } }, isolator, {
    prepareMain: async (path, _issue, base) => {
      await mkdir(path);
      await writeFile(join(path, 'source.txt'), 're-fetchable main');
      return { base, directory: path };
    },
  });
  return { agent, context, sources, upstream, resultPath, work };
}

for (const status of ['completed', 'interrupted']) {
  test(`confirmed ${status} execution discards only source copies`, linux, async t => {
    const f = await fixture(t, status);
    await f.agent.run('shape', f.context);
    for (const path of [f.sources, f.upstream])
      await assert.rejects(access(path), { code: 'ENOENT' });
    assert.ok(await readFile(f.resultPath, 'utf8'));
    assert.equal(await readFile(join(f.work, 'implementation.txt'), 'utf8'),
      'preserve implementation');
  });
}

test('unknown termination preserves sources and recovery input', linux, async t => {
  const f = await fixture(t, 'pending');
  await assert.rejects(f.agent.run('shape', f.context),
    /AGENT_ISOLATION_OR_TERMINATION_UNPROVEN/);
  await access(f.sources);
  await access(f.upstream);
  await access(f.resultPath);
});

test('source cleanup is repeatable and preserves unrelated execution files', async t => {
  await mkdir('.npm', { recursive: true });
  const io = await mkdtemp(resolve('.npm/cleanup-unit-'));
  t.after(() => rm(io, { recursive: true, force: true }));
  const main = join(io, 'current-main');
  const upstream = join(io, 'input', 'upstream');
  await mkdir(main);
  await mkdir(upstream, { recursive: true });
  await writeFile(join(main, 'source.txt'), 'downloaded copy');
  await writeFile(join(upstream, 'source.txt'), 'upstream copy');
  await writeFile(join(io, 'input', 'context.json'), '{}');
  await discardRoleSources(io);
  await discardRoleSources(io);
  for (const path of [main, upstream])
    await assert.rejects(access(path), { code: 'ENOENT' });
  assert.equal(await readFile(join(io, 'input', 'context.json'), 'utf8'), '{}');
});
