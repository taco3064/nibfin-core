import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CodexRoleAgent } from '../src/codex-agent.mjs';
import { codexPlan } from '../src/codex-plan.mjs';
import { readProjectConfig } from '../src/project-config.mjs';
import { digest } from '../src/identity.mjs';
import { stageFixture } from './stage-fixture.mjs';

const coreRoot = resolve(import.meta.dirname, '..');
const stages = ['shape', 'validate-shape', 'review-pr', 'deliver', 'accept'];
const identity = stage => ['validate-shape', 'review-pr'].includes(stage)
  ? 'shape' : stage;
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'nibfin-custom-agent-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateRoot = join(root, 'state'), work = join(root, 'target');
  await mkdir(stateRoot, { mode: 0o700 });
  await mkdir(work);
  const authFile = join(root, 'synthetic-auth.json');
  await writeFile(authFile, JSON.stringify({ auth_mode: 'chatgpt', tokens: {
    access_token: 'synthetic-access-token', refresh_token: 'synthetic-refresh-token',
    id_token: 'synthetic-identity-token-with-no-authority',
    account_id: 'synthetic-account',
  } }), { mode: 0o600 });
  const skills = {}, builtins = {};
  for (const name of ['shape', 'deliver', 'accept']) {
    builtins[name] = await readFile(join(coreRoot, 'skills', name, 'SKILL.md'),
      'utf8');
    skills[name] = digest(builtins[name]);
  }
  const config = { stateRoot, work, projectRoot: work, authFile, coreRoot,
    skills, model: 'configured-model' };
  const adapters = { prepareMain: async (directory, _issue, base) => {
    await mkdir(directory);
    await writeFile(join(directory, 'custom.md'), 'CURRENT MAIN DECOY');
    return { directory, base };
  } };
  return { root, config, adapters, builtins };
}
function context(stage) {
  const value = stageFixture(stage);
  value.execution.id = randomUUID();
  value.execution.sessionId = randomUUID();
  return value;
}

test('all execution roles stage and prompt defaults, extend and override', async t => {
  const f = await fixture(t);
  const custom = 'Incomplete project instructions --yolo /auth/auth.json';
  await writeFile(join(f.config.work, 'custom.md'), custom);
  // Neither the dispatch repository nor the prepared main supplies Skill bytes.
  const dispatch = join(f.root, 'dispatch');
  await mkdir(dispatch);
  await writeFile(join(dispatch, 'custom.md'), 'DISPATCH DECOY');
  for (const stage of stages) {
    const name = identity(stage), builtin = f.builtins[name];
    for (const mode of ['absent-file', 'absent-skills', 'empty', 'other',
      'extend', 'override']) {
      let project;
      if (mode === 'absent-file') project = await readProjectConfig(f.config.work);
      else if (mode === 'absent-skills') project = {};
      else if (mode === 'empty') project = { skills: {} };
      else project = { skills: { [mode === 'other'
        ? (name === 'accept' ? 'deliver' : 'accept') : name]: {
        mode: mode === 'other' ? 'override' : mode, path: 'custom.md',
      } } };
      const expected = mode === 'override' ? custom : mode === 'extend'
        ? `${builtin}\n\n---\n\n${custom}` : builtin;
      let calls = 0;
      const isolator = { execute: async input => {
        calls++;
        assert.equal(await readFile(join(input.input, 'SKILL.md'), 'utf8'),
          expected);
        assert.ok(input.plan.prompt.includes(expected));
        assert.ok(input.plan.prompt.includes('Core execution role: ' + stage));
        const baseline = codexPlan(stage, { model: f.config.model,
          skill: { identity: name, content: builtin, hash: digest(builtin) },
          context: {} });
        for (const key of ['config', 'schema', 'environment', 'requirements',
          'policyHash', 'args', 'writable']) {
          assert.deepEqual(input.plan[key], baseline[key], key);
        }
        return { status: 'interrupted', executionId: input.executionId,
          terminationHash: 'a'.repeat(64) };
      } };
      await new CodexRoleAgent({ ...f.config, project }, isolator, f.adapters)
        .run(stage, context(stage));
      assert.equal(calls, 1);
    }
  }
});

test('same selected declarations read fresh target bytes on each role start', async t => {
  const f = await fixture(t);
  const project = { skills: { shape: { mode: 'override', path: 'custom.md' } } };
  const observed = [];
  const agent = new CodexRoleAgent({ ...f.config, project }, {
    execute: async input => {
      observed.push(await readFile(join(input.input, 'SKILL.md'), 'utf8'));
      return { status: 'interrupted', executionId: input.executionId,
        terminationHash: 'a'.repeat(64) };
    },
  }, f.adapters);
  for (const content of ['first', 'second']) {
    await writeFile(join(f.config.work, 'custom.md'), content);
    await agent.run('shape', context('shape'));
  }
  assert.deepEqual(observed, ['first', 'second']);
});

test('loader errors and malformed override never fall back', async t => {
  const f = await fixture(t);
  let calls = 0;
  const config = { ...f.config,
    project: { skills: { shape: { mode: 'override', path: 'custom.md' } } } };
  const isolator = { execute: async input => {
    calls++;
    assert.equal(await readFile(join(input.input, 'SKILL.md'), 'utf8'), '');
    await writeFile(join(input.output, 'result.json'), '{}');
    return { status: 'completed', executionId: input.executionId,
      terminationHash: 'a'.repeat(64), policyHash: input.plan.policyHash,
      isolationHash: 'b'.repeat(64), probeHash: 'c'.repeat(64),
      stdout: '', stderr: '' };
  } };
  await assert.rejects(new CodexRoleAgent(config, isolator, f.adapters)
    .run('shape', context('shape')), /PROJECT_SKILL/);
  assert.equal(calls, 0);
  await writeFile(join(f.config.work, 'custom.md'), '');
  await assert.rejects(new CodexRoleAgent(config, isolator, f.adapters)
    .run('shape', context('shape')));
  assert.equal(calls, 1);
});
