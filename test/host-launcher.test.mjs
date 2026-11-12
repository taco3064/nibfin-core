import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, chmod, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { acquireHostFence } from '../src/host-fence.mjs';
import {
  resolveHostJob,
  rootOwnedPath,
  hostExecution,
} from '../src/host-launcher.mjs';
import { runnerProviderFixture } from './runner-binding-fixture.mjs';

async function directory(t) {
  const root = await mkdtemp(join(tmpdir(), 'nibfin-host-fence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test(
  'native job lookup derives dynamic IDs but retains ' + 'adopted Runner and source pins',
  async () => {
    const f = runnerProviderFixture();
    f.data['/branches/main'] = {
      protected: true,
      commit: { sha: f.expected.sourceCommit },
    };
    f.reader.list = async (path, key) => {
      assert.equal(path, '/repos/example/core/actions/runs/20/attempts/1/jobs');
      assert.equal(key, 'jobs');
      return [structuredClone(f.job)];
    };
    const env = {
      GITHUB_REPOSITORY: 'example/core',
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      RUNNER_ENVIRONMENT: 'self-hosted',
      GITHUB_RUN_ID: '20',
      GITHUB_RUN_ATTEMPT: '1',
    };
    const adopted = {
      runner: {
        ...f.expected,
        runId: undefined,
        attempt: undefined,
        jobId: undefined,
        actorId: undefined,
      },
    };
    const result = await resolveHostJob(f.reader, adopted, env);
    assert.equal(result.binding.jobId, 30);
    assert.equal(result.runner.actorId, 3);
    const execution = hostExecution(result.runner, 'shape');
    assert.deepEqual(hostExecution(result.runner, 'shape'), execution);
    const repeated = hostExecution(result.runner, 'shape', 1);
    assert.notEqual(repeated.id, execution.id);
    assert.notEqual(repeated.sessionId, execution.sessionId);
    assert.notEqual(hostExecution(result.runner, 'validate-shape').id, execution.id);
    assert.notEqual(
      hostExecution({ ...result.runner, attempt: 2 }, 'shape').id,
      execution.id,
    );
    assert.notEqual(execution.id, execution.sessionId);
    await assert.rejects(
      resolveHostJob(f.reader, adopted, { ...env, GITHUB_EVENT_NAME: 'pull_request' }),
      /INVALID_HOST_CALLER/,
    );
    await assert.rejects(
      resolveHostJob(f.reader, { runner: { ...adopted.runner, runnerId: 999 } }, env),
      /HOST_JOB_NOT_UNIQUE/,
    );
    f.run.head_sha = 'b'.repeat(40);
    await assert.rejects(resolveHostJob(f.reader, adopted, env));
    f.run.head_sha = f.expected.sourceCommit;
    const anchor = f.expected.sourceCommit,
      head = 'b'.repeat(40),
      path = f.expected.workflowPath;
    f.data[`/compare/${anchor}...${head}`] = {
      status: 'ahead',
      merge_base_commit: { sha: anchor },
    };
    f.data[`/contents/${path}?ref=${head}`] = f.data[`/contents/${path}?ref=${anchor}`];
    for (const ref of [anchor, head])
      f.data[`/commits?sha=${ref}&path=${encodeURIComponent(path)}&per_page=1`] = [
        { sha: anchor },
      ];
    f.run.head_sha = head;
    f.job.head_sha = head;
    f.data['/branches/main'].commit.sha = head;
    // An arbitrary workflow may run only its exact adopted commit.
    await assert.rejects(
      resolveHostJob(f.reader, adopted, env),
      /CALLER_EXACT_COMMIT_REQUIRED/,
    );
    // A still-running pinned job can observe main advance after its own merge.
    f.run.head_sha = anchor;
    f.job.head_sha = anchor;
    const running = await resolveHostJob(f.reader, adopted, env);
    assert.equal(running.runner.sourceAnchor, anchor);
    assert.equal(running.binding.sourceCommit, anchor);
    f.data[`/commits?sha=${head}&path=${encodeURIComponent(path)}&per_page=1`] = [
      { sha: head },
    ];
    await assert.rejects(
      resolveHostJob(f.reader, adopted, env),
      /CALLER_REVOKED_OR_SUPERSEDED/,
    );
    f.reader.list = async () => [f.job, { ...f.job, id: 31 }];
    await assert.rejects(resolveHostJob(f.reader, adopted, env), /HOST_JOB_NOT_UNIQUE/);
  },
);

test(
  'host-wide fence blocks concurrent Issues and releases ' +
    'only its unchanged identity',
  async (t) => {
    const root = await directory(t),
      first = await acquireHostFence(root, { issue: 1 });
    assert.equal(await first.inspect(), await first.inspect());
    await assert.rejects(
      acquireHostFence(root, { issue: 2 }),
      /HOST_EXECUTION_UNRESOLVED/,
    );
    await first.release();
    const second = await acquireHostFence(root, { issue: 2 });
    await writeFile(join(root, 'stage.lock'), 'replacement');
    await assert.rejects(second.release(), /HOST_FENCE_CHANGED/);
  },
);

test(
  'an abruptly stopped launcher leaves a durable fence; a ' +
    'new process cannot reclaim it',
  async (t) => {
    const root = await directory(t);
    const module = new URL('../src/host-fence.mjs', import.meta.url).href;
    const child = spawnSync(process.execPath, [
      '--input-type=module',
      '-e',
      `import { acquireHostFence } from ${JSON.stringify(module)};
     await acquireHostFence(process.argv[1], { issue: 1 });
     process.kill(process.pid, 'SIGKILL');`,
      root,
    ]);
    assert.equal(child.signal, 'SIGKILL');
    await assert.rejects(
      acquireHostFence(root, { issue: 1 }),
      /HOST_EXECUTION_UNRESOLVED/,
    );
  },
);

test(
  'unsafe state and an adoption path under a writable ' + 'ancestor are refused',
  async (t) => {
    const root = await directory(t);
    await chmod(root, 0o755);
    await assert.rejects(acquireHostFence(root, {}), /UNTRUSTED_HOST_STATE/);
    await writeFile(join(root, 'host.json'), '{}');
    await assert.rejects(
      rootOwnedPath(join(root, 'host.json')),
      /UNTRUSTED_ADOPTION_PATH/,
    );
  },
);

test(
  'CLI refuses arbitrary stage paths and commands before ' + 'host or network access',
  () => {
    for (const args of [
      ['../1', 'shape'],
      ['1', 'constructor'],
      ['1', 'shape', '--config=/tmp/evil'],
    ]) {
      const child = spawnSync(
        process.execPath,
        ['bin/nibfin-core.mjs', 'stage', ...args],
        {
          encoding: 'utf8',
        },
      );
      assert.equal(child.status, 1);
      const result = JSON.parse(child.stderr);
      assert.equal(result.status, 'denied');
      assert.ok(['INVALID_STAGE_REQUEST', 'INVALID_COMMAND'].includes(result.code));
    }
  },
);
