import { mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectJob } from '../src/project-job.mjs';

const root = await mkdtemp(join(tmpdir(), 'nibfin-project-stage-'));
let roleConfig, environmentConfig, composed = 0;
mock.module('../src/source-package.mjs', { namedExports: {
  verifyInstalledSource: async () => {},
} });
mock.module('../src/codex-agent.mjs', { namedExports: {
  CodexRoleAgent: class {
    constructor(config) { roleConfig = config; }
  },
} });
mock.module('../src/codex-environment.mjs', { namedExports: {
  codexEnvironment: (...args) => {
    environmentConfig = args;
    return { agent: {}, hooks: {} };
  },
} });
mock.module('../src/mcp-agent.mjs', { namedExports: {
  withUserMcp: agent => agent,
} });
mock.module('../src/installed-stage.mjs', { namedExports: {
  installedStageExecutor: options => { composed++; return options; },
} });
const { codexStageExecutor } = await import('../src/codex-stage.mjs');
try {
  for (const name of ['shape', 'deliver', 'accept']) {
    await mkdir(join(root, 'skills', name), { recursive: true });
    await writeFile(join(root, 'skills', name, 'SKILL.md'), 'builtin');
  }
  const work = join(root, 'workspace', 'work');
  await mkdir(work, { recursive: true });
  const project = { skills: {
    deliver: { mode: 'override', path: 'does-not-exist.md' },
  }, tools: { go: '1.24.0' }, allowedDomains: ['example.org'] };
  await writeFile(join(work, '.nibfin.json'), JSON.stringify(project));
  const issue = {
    id: 'I_target', number: 1, repository: 'owner/target', repositoryId: 2,
  };
  const runner = { repository: 'owner/execution', repositoryId: 1, target: issue };
  const job = await projectJob({ workspace: { work }, runner, issue },
    codexStageExecutor);
  const options = {
    installation: { directory: root }, config: { runner,
      approval: { issueId: issue.id } }, isolation: { issue },
    execution: {}, workspaceRoot: join(root, 'workspace'),
    inspectWriter: async () => {},
  };
  await job(options);
  assert.equal(composed, 1);
  assert.deepEqual(roleConfig.project, project);
  assert.equal(roleConfig.projectRoot, work);
  assert.equal(roleConfig.work, work);
  assert.deepEqual(environmentConfig[3], project);
  // The custom path is absent: composition must never read custom instructions.
  assert.equal(roleConfig.skills.deliver.length, 64);
  await assert.rejects(job({ ...options, isolation: {
    issue: { ...issue, id: 'I_foreign' },
  } }), { code: 'HOST_WORKSPACE_SUBJECT_CHANGED' });
  assert.equal(composed, 1);
} finally { await rm(root, { recursive: true, force: true }); }
