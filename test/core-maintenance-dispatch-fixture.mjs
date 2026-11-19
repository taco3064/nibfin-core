import assert from 'node:assert/strict';
import { mock } from 'node:test';
import * as files from 'node:fs/promises';

const scenario = process.argv[2];
const repository = 'taco3064/nibfin-core';
const commit = 'a'.repeat(40);
let posts = 0;
mock.module('node:fs/promises', { namedExports: { ...files,
  readFile: async path => {
    assert.equal(path, 'controlled-event.json');
    return JSON.stringify({ action: 'completed', workflow_run: { id: 31 } });
  },
} });
process.env.GITHUB_EVENT_PATH = 'controlled-event.json';
process.env.GITHUB_EVENT_NAME = 'workflow_run';
process.env.GITHUB_REPOSITORY = repository;
process.env.GH_TOKEN = 'secret-fixture-token';
globalThis.fetch = async (url, options) => {
  const path = new URL(url).pathname;
  if (options.method === 'POST') {
    posts++;
    assert.equal(options.headers['X-GitHub-Api-Version'], '2026-03-10');
    assert.deepEqual(JSON.parse(options.body), { ref: 'main', inputs: {
      cd_run_id: '31', activation_artifact_id: '44' } });
    if (scenario === 'post-422') return new Response('secret-response', { status: 422 });
    if (scenario === 'network')
      throw Object.assign(new Error('secret-network'), { code: 'ECONNRESET' });
    if (scenario === 'lost') return new Response(null, { status: 204 });
    if (scenario === 'post-json') return new Response('{secret-invalid');
    return Response.json({ workflow_run_id: 99,
      html_url: 'https://github.com/' +
        (scenario === 'foreign' ? 'other/repo' : repository) +
        '/actions/runs/99' });
  }
  if (scenario === 'get-422') return new Response('secret-response', { status: 422 });
  if (scenario === 'get-json') return new Response('{secret-invalid');
  if (path.endsWith('/artifacts')) {
    const artifacts = scenario === 'docs' ? [] : [{ id: 44,
      name: `nibfin-activate-${commit}`, expired: false, workflow_run: { id: 31 } }];
    return Response.json({ total_count: artifacts.length, artifacts });
  }
  if (path.endsWith('/actions/runs/31')) return Response.json({ id: 31,
    repository: { id: 12 }, head_repository: { id: 12 }, head_branch: 'main',
    head_sha: commit, path: '.github/workflows/cd.yml', workflow_id: 8,
    event: 'workflow_run', status: 'completed', conclusion: 'success' });
  if (path.endsWith('/actions/workflows/cd.yml')) return Response.json({ id: 8,
    path: '.github/workflows/cd.yml', state: 'active' });
  return Response.json({ id: 12, full_name: repository, default_branch: 'main',
    private: false, archived: false, disabled: false });
};
await import('../scripts/core-maintenance-dispatch.mjs');
process.stderr.write(`fixture-posts=${posts}\n`);
