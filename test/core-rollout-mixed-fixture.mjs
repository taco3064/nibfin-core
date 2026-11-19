import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { gitBlob } from '../src/identity.mjs';
import { resumeRolloutWork } from '../src/rollout-resume.mjs';

export async function mixedResult() {
  const repository = 'taco3064/nibfin-core', sha = 'a'.repeat(40);
  const path = '.github/workflows/shared-runner.yml';
  const source = await readFile(new URL('../' + path, import.meta.url), 'utf8');
  const actor = { id: 4, login: 'owner', type: 'User' };
  const issues = [1, 2].map(number => ({ number, node_id: `I_${number}`,
    state: 'open', labels: [{ name: 'scope' }], assignees: [actor],
    url: `https://api.github.com/repos/${repository}/issues/${number}` }));
  const completed = [], calls = [];
  let failed = true;
  const context = {
    journal: { control: async () => ({ paused: false }) },
    configuration: { memberId: 4, origins: [{ repository, repositoryId: 1 }],
      runner: { repository, repositoryId: 1, workflowId: 50, workflowPath: path,
        sourceCommit: sha, workflowBlob: gitBlob(source) } },
    inspect: async () => {}, completed,
    onDispatched: async result => completed.push(result),
    reader: {
      list: async () => issues,
      issue: async issue => issues.find(value => value.number === issue.number),
      blockedBy: async () => [],
      repository: async () => ({ id: 1, full_name: repository, private: false,
        archived: false, disabled: false, default_branch: 'main' }),
      get: async value => {
        if (value === '/user') return actor;
        if (value.endsWith('/branches/main'))
          return { protected: true, commit: { sha } };
        if (value.endsWith('/actions/workflows/50'))
          return { id: 50, path, state: 'active' };
        if (value.includes('/contents/')) return { type: 'file', path,
          sha: gitBlob(source), encoding: 'base64', size: Buffer.byteLength(source),
          content: Buffer.from(source).toString('base64') };
        throw Error('Unexpected fixture read');
      },
    },
    dispatch: async (destination, inputs) => {
      calls.push(inputs.issue_number);
      if (failed && inputs.issue_number === '2') throw Object.assign(Error('private'),
        { githubApiRead: true, status: 422 });
      return { runId: 60 + Number(inputs.issue_number),
        url: `https://github.com/${repository}/actions/runs/` +
          (60 + Number(inputs.issue_number)) };
    },
  };
  const first = await resumeRolloutWork(context);
  assert.equal(first.status, 'pending');
  failed = false;
  assert.equal((await resumeRolloutWork(context)).status, 'dispatched');
  assert.deepEqual(calls, ['1', '2', '2']);
  const secret = 'DO-NOT-PUBLISH-provider-token-url-body';
  first.results[0].token = secret;
  first.results[1].body = secret;
  first.results[1].githubApi.url = secret;
  return { status: 'installed', installation: 'complete', continuation: first };
}
