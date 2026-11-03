import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';
import { codexStageExecutor } from '../src/codex-stage.mjs';
import { installedStageExecutor } from '../src/installed-stage.mjs';
import { digest, sha256 } from '../src/identity.mjs';
import { nativeFixture } from './native-observer-fixture.mjs';
import { approvalRecord, now } from './approval-fixture.mjs';

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const issuer = 'https://token.actions.githubusercontent.com';
const request = { schemaVersion: 1, stage: 'shape' };
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'nibfin-installed-stage-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'src'));
  const bytes = Buffer.from('Synthetic installed source\n');
  await writeFile(join(directory, 'src/example.mjs'), bytes);
  const files = [{ path: 'src/example.mjs', mode: '100644', size: bytes.length, sha256: sha256(bytes) }];
  for (const name of ['shape', 'deliver', 'accept']) {
    const path = `skills/${name}/SKILL.md`, content = `---\nname: ${name}\n---\nSynthetic Skill\n`;
    await mkdir(join(directory, 'skills', name), { recursive: true });
    await writeFile(join(directory, path), content);
    files.push({ path, mode: '100644', size: Buffer.byteLength(content), sha256: sha256(Buffer.from(content)) });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  const manifest = { schemaVersion: 1, repository: 'taco3064/nibfin-core', commit: 'a'.repeat(40), files,
    policyHash: digest(files.filter(file => file.path.startsWith('src/'))), skillsHash: digest(files.filter(file => file.path.startsWith('skills/'))) };
  await writeFile(join(directory, 'nibfin-manifest.json'), JSON.stringify(manifest));
  const record = approvalRecord();
  record.source = { repository: manifest.repository, commit: manifest.commit, policyHash: manifest.policyHash, skillsHash: manifest.skillsHash };
  const f = await nativeFixture(t, record);
  const runner = f.runner.expected, execution = f.adapters.execution;
  const caller = { pin: { repository: runner.repository, repositoryId: runner.repositoryId, ownerId: 20,
    subject: 'repo:example/core:ref:refs/heads/main', ref: 'refs/heads/main',
    workflowRef: `${runner.repository}/${runner.workflowPath}@refs/heads/main` },
    requestUrl: 'https://vstoken.actions.githubusercontent.com/token', requestToken: 'synthetic-request-token' };
  const payload = { iss: issuer, aud: `nibfin:10:${execution.id}`, sub: caller.pin.subject,
    iat: now / 1000 - 10, nbf: now / 1000 - 10, exp: now / 1000 + 290, jti: 'fixture',
    repository: runner.repository, repository_id: '10', repository_owner_id: '20', repository_visibility: 'public',
    run_id: '20', run_attempt: '1', actor_id: '3', check_run_id: '40', runner_environment: 'self-hosted',
    event_name: 'workflow_dispatch', workflow_ref: caller.pin.workflowRef, workflow_sha: runner.sourceCommit,
    sha: runner.sourceCommit, ref: caller.pin.ref, ref_type: 'branch', head_ref: '', base_ref: '' };
  let calls = 0, effects = 0;
  const fetcher = async (url, options) => {
    calls++;
    const parsed = new URL(url);
    assert.equal(options.redirect, 'error');
    let value;
    if (parsed.hostname === 'vstoken.actions.githubusercontent.com') {
      assert.equal(options.headers.Authorization, 'Bearer synthetic-request-token');
      assert.equal(parsed.searchParams.get('audience'), payload.aud);
      const body = [{ typ: 'JWT', alg: 'RS256', kid: 'fixture' }, payload]
        .map(item => Buffer.from(JSON.stringify(item)).toString('base64url')).join('.');
      value = { value: `${body}.${sign('RSA-SHA256', Buffer.from(body), keys.privateKey).toString('base64url')}` };
    } else if (parsed.origin === issuer) {
      assert.equal(options.headers, undefined);
      value = parsed.pathname.endsWith('/jwks') ? { keys: [{ ...keys.publicKey.export({ format: 'jwk' }),
        kid: 'fixture', use: 'sig', alg: 'RS256' }] } : { issuer, jwks_uri: `${issuer}/.well-known/jwks` };
    } else {
      assert.equal(parsed.origin, 'https://api.github.com');
      assert.equal(options.headers.Authorization, 'Bearer synthetic-api-token');
      if (parsed.pathname === '/repos/example/core') value = f.authority.repo;
      else if (parsed.pathname === '/repos/example/core/issues/2') value = f.issue;
      else {
        if (parsed.searchParams.get('per_page') === '100') parsed.searchParams.delete('per_page');
        parsed.searchParams.delete('page');
        const key = parsed.pathname.slice('/repos/example/core'.length) + parsed.search;
        assert.ok(Object.hasOwn(f.data, key), key); value = f.data[key];
      }
    }
    return { ok: true, text: async () => JSON.stringify(value), json: async () => structuredClone(value) };
  };
  const agent = { run: async (_stage, context) => {
    effects++;
    const lastMessage = JSON.stringify({ outcome: 'ready', body: f.context.shape.body, summary: 'Synthetic execution',
      rootCause: '', failureClass: 'none', evidenceReferences: ['fixture:role'], blockingFindings: [], contractConflicts: [] });
    return { executionId: context.execution.id, terminationHash: 'a'.repeat(64), lastMessage,
      stdout: [{ type: 'thread.started', thread_id: context.execution.sessionId }, { type: 'turn.started' },
        { type: 'item.completed', item: { type: 'agent_message', text: lastMessage } },
        { type: 'turn.completed' }].map(JSON.stringify).join('\n') };
  } };
  const options = { installation: { directory, pin: { repository: manifest.repository, commit: manifest.commit, manifestHash: digest(manifest) } },
    caller, config: f.adapters.config, execution, inspectIsolation: f.adapters.inspectIsolation, agent,
    workspace: { push: async () => { throw new Error('Unexpected write'); } },
    sandbox: { execute: async () => { throw new Error('Unexpected hook'); } }, token: 'synthetic-api-token', fetcher, clock: () => now };
  return { options, directory, payload, calls: () => calls, effects: () => effects };
}

test('installed executor verifies real source files, signed caller and native approval before persisting a stage result', async t => {
  const f = await fixture(t), executor = await installedStageExecutor(f.options);
  assert.equal(f.calls(), 0);
  const result = await executor.run(request);
  assert.equal(result.status, 'completed', JSON.stringify(result)); assert.equal(f.effects(), 1);
  assert.equal((await executor.run(request)).code, 'REPLAYED_OPERATION');
});

test('source modification after installation denies before any native or Agent access', async t => {
  const f = await fixture(t), executor = await installedStageExecutor(f.options);
  await writeFile(join(f.directory, 'src/example.mjs'), 'Modified');
  assert.equal((await executor.run(request)).code, 'INSTALLED_SOURCE_CHANGED');
  assert.equal(f.calls(), 0); assert.equal(f.effects(), 0);
  await assert.rejects(installedStageExecutor(f.options), /INSTALLED_SOURCE_CHANGED/);
});

test('wrong native caller and different approved source cannot authorize installed execution', async t => {
  const f = await fixture(t); f.payload.check_run_id = '41';
  assert.equal((await (await installedStageExecutor(f.options)).run(request)).status, 'denied');
  assert.equal(f.effects(), 0);
  f.options.config.approval.source.commit = 'b'.repeat(40);
  await assert.rejects(installedStageExecutor(f.options), /ADOPTED_SOURCE_MISMATCH/);
  f.options.caller.pin.repositoryId = 99;
  await assert.rejects(installedStageExecutor(f.options), /INSTALLATION_CALLER_BINDING_MISMATCH/);
});


test('fixed Codex assembly cannot substitute a config flag for live writer exclusivity', async t => {
  const f = await fixture(t);
  const shared = { docker: '/nonexistent/docker', image: 'sha256:' + 'a'.repeat(64), socket: '/run/user/1000/docker.sock' };
  const options = { ...f.options, workspaceRoot: join(f.directory, 'unused-workspace'),
    agentStateRoot: join(f.directory, 'unused-agent'), authFile: join(f.directory, 'unused-auth'), model: 'fixture-model',
    isolation: { kind: 'linux-rootless-docker-v1', issue: approvalRecord().issue, hooks: shared,
      agent: { ...shared, gatewayId: 'b'.repeat(64), network: 'fixture-network',
        codexVersion: 'codex-cli 0.138.0', proxyScript: '/nonexistent/proxy.mjs' } },
    inspectWriter: async () => null };
  await assert.rejects(codexStageExecutor({ ...options, inspectWriter: undefined }), /SUPPORTED_HOST_PROOF_REQUIRED/);
  const executor = await codexStageExecutor(options);
  assert.equal((await executor.run(request)).status, 'denied');
  assert.equal(f.effects(), 0);
  options.isolation.issue = { ...options.isolation.issue, id: 'I_foreign' };
  await assert.rejects(codexStageExecutor(options), /HOST_WORKSPACE_SUBJECT_CHANGED/);
});
