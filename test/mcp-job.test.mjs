import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { Readable, PassThrough } from 'node:stream';
import { claimMcpJob, jobMcpProfile, mcpJobBinding } from '../src/mcp-job.mjs';
import { withUserMcp } from '../src/mcp-agent.mjs';
import { mcpRequest, validateMcpResponse, readMcpFrame,
  encodeMcpFrame } from '../src/mcp-job-codec.mjs';
import { mcpJobChannel } from '../src/mcp-job-channel.mjs';
import { inheritUserMcp } from '../src/mcp-profile.mjs';
import { bindMcpProfile } from '../src/mcp-resolve.mjs';
import { digest } from '../src/identity.mjs';
import { prepareHostJobMcp } from '../src/mcp-job-host.mjs';
import { createMcpDelegation } from '../src/mcp-delegation.mjs';

const binding = { repositoryId: 1, memberId: 2, runnerId: 3,
  runId: 4, attempt: 1, jobId: 5 };
const proof = 'a'.repeat(64);
const nonce = 'b'.repeat(64);

async function directory(t) {
  const root = await mkdtemp(join(tmpdir(), 'nibfin-job-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('atomic Job claim refuses concurrent and repeated entry', async t => {
  const root = await directory(t);
  const results = await Promise.allSettled(Array.from({ length: 8 }, () =>
    claimMcpJob(root, binding)));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  for (const result of results.filter(item => item.status === 'rejected'))
    assert.equal(result.reason.code, 'MCP_JOB_ALREADY_CLAIMED');
  const claim = results.find(item => item.status === 'fulfilled').value;
  await claim.inspect();
  await assert.rejects(claimMcpJob(root, binding), { code: 'MCP_JOB_ALREADY_CLAIMED' });
  await claimMcpJob(root, { ...binding, jobId: 6 });
  const bad = { ...binding, runId: 0 };
  assert.throws(() => mcpJobBinding(bad), { code: 'INVALID_MCP_JOB' });
  const path = join(claim.directory, digest(binding) + '.json');
  await writeFile(path, '{}');
  await assert.rejects(claim.inspect(), { code: 'MCP_JOB_GUARD_CHANGED' });
  await assert.rejects(claimMcpJob(root, binding), { code: 'MCP_JOB_ALREADY_CLAIMED' });
});

test('a new controller process refuses an existing Job claim before export',
  async t => {
    const root = await directory(t);
    const module = pathToFileURL(join(process.cwd(), 'src/mcp-job.mjs')).href;
    const script = `
import {claimMcpJob} from ${JSON.stringify(module)};
try {
  await claimMcpJob(process.argv[2], JSON.parse(process.argv[3]));
  process.stdout.write('export');
} catch (error) { process.stdout.write(error.code); process.exitCode=1; }
`;
    const entry = join(root, 'entry.mjs');
    await writeFile(entry, script, { mode: 0o600 });
    const run = () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [entry, root, JSON.stringify(binding)], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '', stderr = '';
      child.stderr.on('data', bytes => { stderr += bytes; });
      child.on('error', reject);
      child.stdout.on('data', bytes => { stdout += bytes; });
      child.on('close', code => {
        assert.equal(stderr, '', `unexpected child diagnostics: ${stderr}`);
        resolve({ code, stdout });
      });
    });
    assert.deepEqual(await run(), { code: 0, stdout: 'export' });
    assert.deepEqual(await run(), { code: 1, stdout: 'MCP_JOB_ALREADY_CLAIMED' });
  });

test('unsafe guard parents and substituted guard links fail closed', async t => {
  const root = await directory(t), outside = await directory(t);
  await symlink(outside, join(root, 'mcp-jobs'));
  await assert.rejects(claimMcpJob(root, binding), { code: 'UNTRUSTED_HOST_STATE' });
});

test('one immutable profile crosses stages and independent role wrappers', async t => {
  const root = await directory(t);
  const output = join(root, 'output');
  await mkdir(output, { mode: 0o700 });
  await writeFile(join(output, 'result.json'), '{}', { mode: 0o600 });
  let exports = 0;
  const profile = bindMcpProfile(inheritUserMcp({ fixture: {
    url: 'https://mcp.example.test/mcp', enabled_tools: ['read'],
    http_headers: { Authorization: 'Bearer synthetic-job-secret' },
  } }));
  profile.expiresAt = Date.now() + 2 * 3600000;
  const job = jobMcpProfile(async () => { exports++; return profile; });
  const identities = [];
  for (const role of ['author', 'validator', 'writer', 'acceptor']) {
    const isolator = withUserMcp({
      preflight: async () => ({ observationHash: proof }),
      execute: async input => {
        identities.push(input.mcp);
        return { status: 'completed', terminationHash: proof,
          stdout: role, stderr: '' };
      },
    }, {}, () => job.read(), job);
    await isolator.preflight();
    const result = await isolator.execute({ output, plan: { args: [], prompt: '' } });
    await assert.rejects(job.retire([], true), {
      code: 'MCP_JOB_TERMINATION_UNPROVEN',
    });
    await result.retireMcp();
  }
  assert.equal(exports, 1);
  assert.ok(identities.every(value => value === profile));
  assert.throws(() => { profile.configuration.mcp_servers.fixture.enabled = false; });
  await job.retire([], true);
  assert.throws(() => job.read(), { code: 'MCP_JOB_RETIRED' });
  const next = jobMcpProfile(async () => { exports++; return profile; });
  await next.read();
  assert.equal(exports, 2);
});

test('failed preparation never retries; uncertain consumer retains generated copies',
  async t => {
    let reads = 0;
    const failure = jobMcpProfile(async () => { reads++; throw Error('unavailable'); });
    await assert.rejects(failure.read());
    await assert.rejects(failure.read());
    assert.equal(reads, 1);
    const root = await directory(t), copies = join(root, 'copies');
    await mkdir(copies, { mode: 0o700 });
    await writeFile(join(copies, 'source.json'), '{}');
    const job = jobMcpProfile(async () => ({}));
    await job.read();
    const finish = job.enter();
    await assert.rejects(job.retire([copies], true), {
      code: 'MCP_JOB_TERMINATION_UNPROVEN',
    });
    finish(false);
    await assert.rejects(job.retire([copies], true), {
      code: 'MCP_JOB_TERMINATION_UNPROVEN',
    });
    assert.equal(await readFile(join(copies, 'source.json'), 'utf8'), '{}');
    const clean = jobMcpProfile(async () => ({}));
    const stopped = clean.enter();
    stopped(true);
    await clean.retire([copies], true);
    await assert.rejects(readFile(join(copies, 'source.json')), { code: 'ENOENT' });
  });

test('secret output preserves Pending and prevents retirement', async t => {
  const root = await directory(t);
  for (const channel of ['stdout', 'stderr', 'file']) {
    const output = join(root, channel);
    await mkdir(output, { mode: 0o700 });
    const secret = 'synthetic-only-delegated-access-token';
    await writeFile(join(output, 'result.json'), channel === 'file' ? secret : '{}');
    const profile = { expiresAt: null, policyHash: proof, secrets: [secret],
      metadata: {}, configuration: { mcp_servers: {} } };
    const job = jobMcpProfile(async () => profile);
    let cleaned = false;
    const isolator = withUserMcp({ execute: async () => ({
      status: 'completed', terminationHash: proof,
      stdout: channel === 'stdout' ? secret : '',
      stderr: channel === 'stderr' ? secret : '',
      retireMcp: async () => { cleaned = true; },
    }) }, {}, () => job.read(), job);
    await assert.rejects(isolator.execute({ output, plan: { args: [], prompt: '' } }),
      { code: 'MCP_CREDENTIAL_OUTPUT_REJECTED' });
    assert.equal(cleaned, false);
    await assert.rejects(job.retire([], true), {
      code: 'MCP_JOB_TERMINATION_UNPROVEN',
    });
  }
});

test('codec rejects wrong Job bindings, duplicates and oversized frames', async () => {
  const request = mcpRequest(binding, nonce);
  const response = { ...request, delegation: {}, terminated: true,
    nativeTerminated: true };
  assert.deepEqual(validateMcpResponse(response, request), {});
  for (const nativeTerminated of [undefined, false])
    assert.throws(() => validateMcpResponse({ ...response, nativeTerminated }, request));
  for (const key of Object.keys(binding))
    assert.throws(() => validateMcpResponse({ ...response,
      binding: { ...binding, [key]: binding[key] + 1 } }, request));
  assert.throws(() => validateMcpResponse({ ...response, nonce: proof }, request));
  for (const text of ['', '{}', '{}\n{}\n', 'bad\n', '{}\ntrailing'])
    await assert.rejects(readMcpFrame(Readable.from([text])));
  await assert.rejects(readMcpFrame(Readable.from([Buffer.alloc(1024 * 1024 + 1)])),
    { code: 'MCP_JOB_FRAME_TOO_LARGE' });
  assert.deepEqual(await readMcpFrame(Readable.from([encodeMcpFrame(request)])),
    request);
});

test('request framing separates request delimiter, EOF and duplicate bytes', async () => {
  const input = new PassThrough();
  let cancellations = 0;
  const channel = mcpJobChannel(input, () => { cancellations++; });
  const request = mcpRequest(binding, nonce);
  input.write(encodeMcpFrame(request));
  assert.deepEqual(await channel.request, request);
  assert.equal(cancellations, 0);
  input.write(encodeMcpFrame(request));
  assert.equal(cancellations, 1);
  assert.equal(channel.cancelled, true);
  input.end();
});

test('host shares one acquisition and refuses completed-Job replay', async t => {
  const root = await directory(t);
  const host = { stateRoot: root, mcp: { kind: 'native-job-v1', controllerGid: 988 } };
  const runner = { ...binding, repository: 'owner/repo',
    actionCommit: '0716d30b0b05e7f626fefa3c566b5941096f6312' };
  const approval = { record: {
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  } };
  let acquisitions = 0, loads = 0;
  const profile = bindMcpProfile(inheritUserMcp({ fixture: {
    url: 'https://mcp.example.test/mcp', enabled_tools: ['read'],
  } }));
  Object.assign(profile.metadata, {
    nativeVersion: 'codex-cli 0.166.0', sourceHash: proof,
  });
  const capsule = createMcpDelegation(profile, binding.memberId);
  const blobs = {
    'action.yml': '2a12b995034ac2234132f97f59df5bd9c2496c2b',
    'src/main.mjs': '9ae143c20c87cb9c1504659447bd4272c9c05639',
    'src/core-cli.mjs': '38e72e654602fe672cad2b13b101234f410e6ded',
  };
  const get = async path => {
    if (path.includes('/contents/')) {
      const [name, ref] = path.split('/contents/')[1].split('?ref=');
      return { sha: ref === runner.actionCommit ? blobs[name] : null };
    }
    return {
    id: runner.jobId, run_id: runner.runId, run_attempt: runner.attempt,
    runner_id: runner.runnerId, status: 'in_progress', conclusion: null,
    };
  };
  const options = { host, runner, approval, reader: { get } };
  const adapters = {
    inspectEndpoint: async () => {},
    acquire: async (_source, actual, { signal }) => {
      signal.throwIfAborted();
      assert.deepEqual(actual, binding);
      const guard = join(root, 'mcp-jobs', digest(actual) + '.json');
      assert.deepEqual(JSON.parse(await readFile(guard)).binding, binding);
      acquisitions++;
      return capsule;
    },
    load: async () => { loads++; return structuredClone(profile); },
  };
  const job = await prepareHostJobMcp(options, adapters);
  t.after(() => job.stop());
  const first = await job.read();
  assert.equal(first, await job.read());
  assert.equal(acquisitions, 1);
  assert.equal(loads, 1);
  await job.retire(true);
  job.stop();
  await assert.rejects(prepareHostJobMcp(options, adapters), {
    code: 'MCP_JOB_ALREADY_CLAIMED',
  });
  assert.equal(acquisitions, 1);
  await assert.rejects(prepareHostJobMcp({ ...options,
    runner: { ...runner, actionCommit: 'c'.repeat(40) } }, adapters), {
    code: 'UNSUPPORTED_MCP_JOB_CALLER',
  });
});

test('expiry between stages refuses execution without profile replacement', async t => {
  const start = Date.now();
  let clock = start, reads = 0;
  t.mock.method(Date, 'now', () => clock);
  const profile = { expiresAt: start + 31 * 60000, policyHash: proof,
    configuration: { mcp_servers: {} }, metadata: {}, secrets: [] };
  const job = jobMcpProfile(async () => { reads++; return profile; });
  const wrapper = () => withUserMcp({
    preflight: async () => ({ observationHash: proof }),
  }, {}, () => job.read(), job);
  await wrapper().preflight();
  clock += 2 * 60000;
  await assert.rejects(wrapper().preflight(), {
    code: 'USER_MCP_AUTHENTICATION_REFRESH_REQUIRED',
  });
  assert.equal(reads, 1);
});

test('relay absence requires ESRCH; permission denial and cancellation are not proof',
  async t => {
    const { waitMcpRelayAbsent } = await import('../src/mcp-job-transport.mjs');
    const observation = t.mock.method(process, 'kill', () => {
      throw Object.assign(Error('absent'), { code: 'ESRCH' });
    });
    await waitMcpRelayAbsent(123);
    observation.mock.mockImplementation(() => {
      throw Object.assign(Error('unobservable'), { code: 'EPERM' });
    });
    await assert.rejects(waitMcpRelayAbsent(123), {
      code: 'MCP_JOB_RELAY_TERMINATION_UNPROVEN',
    });
    observation.mock.mockImplementation(() => true);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(waitMcpRelayAbsent(123, { signal: controller.signal }), {
      name: 'AbortError',
    });
  });
