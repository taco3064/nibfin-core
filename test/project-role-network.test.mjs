import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { CodexRoleAgent } from '../src/codex-agent.mjs';
import { projectJob } from '../src/project-job.mjs';
import { codexEnvironment } from '../src/codex-environment.mjs';
import { digest } from '../src/identity.mjs';
import { stageFixture } from './stage-fixture.mjs';
import { acquireProjectEgress } from '../src/mcp-egress.mjs';
import { policyPermits, projectDomains } from '../src/egress-proxy.mjs';

test('actual role planning and environment keep target snapshot across role executions',
  async t => {
    const root = await mkdtemp(join(tmpdir(), 'nibfin-role-network-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const work = join(root, 'work'), stateRoot = join(root, 'state');
    await mkdir(work); await mkdir(stateRoot, { mode: 0o700 });
    const authFile = join(root, 'auth.json'), coreRoot = resolve('.');
    await writeFile(authFile, JSON.stringify({ auth_mode: 'chatgpt', tokens: {
      access_token: 'synthetic-access-with-no-authority',
      refresh_token: 'synthetic-refresh-with-no-authority',
      id_token: 'synthetic-identity-with-no-authority', account_id: 'fixture',
    } }), { mode: 0o600 });
    const skills = {};
    for (const name of ['shape', 'deliver', 'accept'])
      skills[name] = digest(await readFile(join(coreRoot, 'skills', name, 'SKILL.md'),
        'utf8'));
    const directory = join(root, 'policy');
    await mkdir(directory, { mode: 0o755 });
    const issue = { repository: 'owner/target', repositoryId: 2 };
    const runner = { repository: 'owner/dispatch', repositoryId: 1, target: issue };
    let environmentDomains, observed = [], roleReads = 0;
    class AgentEnvironment {
      constructor(config) { environmentDomains = config.additionalDomains; }
    }
    class HooksEnvironment {}
    const compose = async ({ project }) => {
      const hooks = { docker: '/usr/bin/docker', socket: '/socket' };
      await codexEnvironment({ kind: 'linux-rootless-docker-v1', agent: hooks, hooks },
        coreRoot, undefined, project,
        { AgentSandbox: AgentEnvironment, HookSandbox: HooksEnvironment });
      const selected = projectDomains(environmentDomains);
      const isolator = { async execute({ plan, executionId, input }) {
        if (roleReads < 2) {
          const custom = roleReads === 0 ? 'first project Skill'
            : 'updated project Skill';
          const staged = await readFile(join(input, 'SKILL.md'), 'utf8');
          assert.ok(staged.endsWith(custom));
          assert.ok(plan.prompt.includes(custom));
          if (roleReads === 1) assert.equal(staged, custom);
        }
        roleReads++;
        observed.push(plan.additionalDomains);
        assert.deepEqual(plan.additionalDomains, selected);
        for (const host of selected)
          assert.ok(plan.requirements.includes(JSON.stringify(host)));
        assert.ok(!plan.requirements.includes('dispatch.example.com'));
        assert.ok(!plan.requirements.includes('mcp.notion.com'));
        const lease = await acquireProjectEgress(directory, executionId, selected);
        for (const host of selected)
          assert.equal(await policyPermits(directory, host, true), true);
        assert.equal(await policyPermits(directory, 'foreign.example.com', true), false);
        await lease.release();
        return { status: 'interrupted', executionId, terminationHash: 'a'.repeat(64) };
      } };
      return new CodexRoleAgent({ work, stateRoot, authFile, coreRoot, skills,
        model: 'model', project, projectRoot: work }, isolator, {
        prepareMain: async (path, _issue, head) => {
          await mkdir(path); return { directory: path, base: head };
        },
      });
    };
    const setup = () => projectJob({ workspace: { work }, runner, issue }, compose);
    await writeFile(join(work, '.nibfin.json'), JSON.stringify({
      allowedDomains: ['API.Example.com', 'api.example.com'],
      skills: {
        shape: { mode: 'extend', path: 'custom.md' },
        accept: { mode: 'override', path: 'custom.md' },
      },
    }));
    await writeFile(join(work, 'custom.md'), 'first project Skill');
    const job = await setup();
    await (await job({})).run('shape', stageFixture('shape'));
    await writeFile(join(work, '.nibfin.json'), JSON.stringify({
      allowedDomains: ['next.example.com'],
    }));
    await writeFile(join(work, 'custom.md'), 'updated project Skill');
    await (await job({})).run('accept', stageFixture('accept'));
    const next = await setup();
    await (await next({})).run('deliver', stageFixture('deliver'));
    // Each native Job has a fresh private state root. These fixture contexts
    // reuse execution identities, so use another root for the defaults check.
    await rm(stateRoot, { recursive: true });
    await mkdir(stateRoot, { mode: 0o700 });
    await writeFile(join(work, '.nibfin.json'), '{"allowedDomains":[]}');
    await (await (await setup())({})).run('deliver', stageFixture('deliver'));
    assert.deepEqual(observed,
      [['api.example.com'], ['api.example.com'], ['next.example.com'], []]);
  });
