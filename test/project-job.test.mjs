import { spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectJob } from '../src/project-job.mjs';
import { codexEnvironment } from '../src/codex-environment.mjs';

const issue = { repository: 'owner/target', repositoryId: 2 };
const runner = { repository: 'owner/execution', repositoryId: 1, target: issue };
const first = {
  tools: { node: '22.15.0' }, allowedDomains: ['pypi.org'],
  skills: { deliver: { mode: 'override', path: 'missing-skill.md' } },
};

test('Job setup selects target once; subsequent Jobs remain independent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nibfin-job-'));
  const work = join(root, 'target'), execution = join(root, 'execution');
  try {
    await mkdir(work); await mkdir(execution);
    await writeFile(join(execution, '.nibfin.json'), JSON.stringify({
      tools: { python: '3.13.7' }, allowedDomains: ['execution.example.org'],
    }));
    const setup = compose => projectJob({ workspace: { work }, runner, issue }, compose);
    const absent = await setup(options => options);
    assert.deepEqual(absent({}).project, {});
    await writeFile(join(work, '.nibfin.json'), JSON.stringify(first));
    const observed = [];
    const compose = options => { observed.push(options); return options; };
    const job = await setup(compose);
    const a = job({ stage: 'deliver' });
    await writeFile(join(work, '.nibfin.json'), JSON.stringify({
      tools: { python: '3.13.7' }, allowedDomains: ['example.org'],
    }));
    const b = job({ stage: 'accept' });
    assert.equal(a.project, b.project);
    assert.deepEqual(b.project, first);
    assert.equal(b.projectRoot, work);
    assert.throws(() => b.project.allowedDomains.push('evil.org'), TypeError);
    const next = await setup(compose);
    assert.deepEqual(next({}).project, {
      tools: { python: '3.13.7' }, allowedDomains: ['example.org'],
    });
    await rm(join(work, '.nibfin.json'));
    assert.deepEqual((await setup(compose))({}).project, {});
    await assert.rejects(projectJob({ workspace: { work }, runner,
      issue: { ...issue, repositoryId: 99 } }, compose), {
      code: 'HOST_WORKSPACE_SUBJECT_CHANGED',
    });
    const otherJob = await projectJob({
      workspace: { work: execution },
      runner: { repository: 'owner/other', repositoryId: 3 },
      issue: { repository: 'owner/other', repositoryId: 3 },
    }, compose);
    assert.deepEqual(otherJob({}).project, {
      tools: { python: '3.13.7' }, allowedDomains: ['execution.example.org'],
    });
    assert.equal(observed.length, 5);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('environment hands declarations to consumers without changing policy', async () => {
  const captured = [];
  class Consumer {
    constructor(config, options) { captured.push({ config, options }); }
  }
  const hooks = { docker: '/usr/bin/docker', socket: '/socket', image: 'fixed' };
  await codexEnvironment({ kind: 'linux-rootless-docker-v1', agent: hooks, hooks },
    '/core', undefined, first, { AgentSandbox: Consumer, HookSandbox: Consumer,
      toolEnvironment: async () => null });
  assert.deepEqual(captured[0].config.projectTools, first.tools);
  assert.deepEqual(captured[0].config.additionalDomains, first.allowedDomains);
  assert.equal(captured[0].config.image, 'fixed');
  assert.deepEqual(captured[1].config, hooks);
  assert.deepEqual(captured[1].options.projectTools, first.tools);
  assert.equal(captured.length, 2);
});

test('both shared slots select the committed backend once per Job', async t => {
  const work = await mkdtemp(join(tmpdir(), 'nibfin-writer-backend-'));
  t.after(() => rm(work, { recursive: true, force: true }));
  const jobVm = { rootDisk: '/host-configured/disk' };
  const firstHead = 'a'.repeat(40), secondHead = 'b'.repeat(40);
  const configs = { [firstHead]: '{"writerBackend":"docker"}',
    [secondHead]: '{"writerBackend":"firecracker"}' };
  await writeFile(join(work, '.nibfin.json'), '{"writerBackend":"stale"}');
  const workspace = { work, committedProjectConfig: async head => configs[head] };
  for (const runnerId of [25, 26]) {
    const slot = { ...runner, runnerId };
    let head = firstHead;
    const setup = options => projectJob({ workspace, runner: slot, issue,
      observeMain: async () => ({ head }), ...options }, data => data);
    const docker = await setup({ jobVm });
    assert.equal(docker({ jobVm }).jobVm, undefined);
    head = secondHead;
    assert.equal(docker({ jobVm }).jobVm, undefined);
    assert.equal((await setup({ jobVm }))({}).jobVm, jobVm);
    await assert.rejects(setup({}), /writerBackend: firecracker is not enabled/);
    head = firstHead;
    assert.equal((await setup({}))({}).jobVm, undefined);
  }
  configs[firstHead] = null;
  for (const available of [undefined, jobVm]) {
    const job = await projectJob({ workspace, runner, issue, jobVm: available,
      observeMain: async () => ({ head: firstHead }) }, data => data);
    assert.equal(job({}).jobVm, available);
  }
});

test('stage composition hands current work-tree Skill declarations to the role', () => {
  const result = spawnSync(process.execPath, [
    '--experimental-test-module-mocks', 'test/project-stage-fixture.mjs',
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
