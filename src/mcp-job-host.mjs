import { mkdir, rm, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { digest, requireThat } from './identity.mjs';
import { repoPath } from './github-read.mjs';
import { claimMcpJob, jobMcpProfile } from './mcp-job.mjs';
import { acquireNativeJobMcp, inspectMcpJobEndpoint } from './mcp-job-transport.mjs';
import { storePrivateMcpDelegation } from './mcp-transfer.mjs';
import { loadUserMcp } from './mcp-source.mjs';

// Reviewed entry behavior remains valid across Core package pin updates.
const singleEntryAction = {
  'action.yml': ['2a12b995034ac2234132f97f59df5bd9c2496c2b'],
  'src/main.mjs': ['9ae143c20c87cb9c1504659447bd4272c9c05639'],
  'src/core-cli.mjs': [
    '38e72e654602fe672cad2b13b101234f410e6ded',
    '7f8e13ffbc58c27d2fc7fd83acf94be9829cd3fa',
  ],
};

async function verifyActionEntry(reader, commit) {
  requireThat(/^[a-f0-9]{40}$/.test(commit), 'UNSUPPORTED_MCP_JOB_CALLER');
  for (const [path, blobs] of Object.entries(singleEntryAction)) {
    const url = '/repos/taco3064/nibfin-act/contents/' + path + '?ref=' + commit;
    const file = await reader.get(url);
    requireThat(blobs.includes(file.sha), 'UNSUPPORTED_MCP_JOB_CALLER');
  }
}

export async function prepareHostJobMcp({ host, runner, reader, approval }, {
  claimJob = claimMcpJob, inspectEndpoint = inspectMcpJobEndpoint,
  acquire = acquireNativeJobMcp, store = storePrivateMcpDelegation,
  load = loadUserMcp, authorize = async () => {},
} = {}) {
  if (host.mcp === undefined) return null;
  // readRunnerBinding has already checked the exact single-step Caller recipe.
  // Initial support is the independently inspected single-entry Action chain.
  requireThat(!runner.reusable &&
    !runner.wakeWorkflow, 'UNSUPPORTED_MCP_JOB_CALLER');
  await verifyActionEntry(reader, runner.actionCommit);
  const claim = await claimJob(host.stateRoot, runner);
  await inspectEndpoint(host.mcp);
  const copies = join(claim.directory, digest(claim.binding) + '.copies');
  const controller = new AbortController();
  let closed = false, timer;
  const abort = () => controller.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  const poll = async () => {
    if (closed) return;
    try {
      const job = await reader.get(
        `${repoPath(runner.repository)}/actions/jobs/${runner.jobId}`);
      requireThat(job.id === runner.jobId && job.run_id === runner.runId &&
        job.run_attempt === runner.attempt && job.runner_id === runner.runnerId &&
        job.status === 'in_progress' && job.conclusion === null &&
        Date.now() < Date.parse(approval.record.expiresAt), 'MCP_JOB_CANCELLED');
    } catch { abort(); }
    if (!closed && !controller.signal.aborted) timer = setTimeout(poll, 1000);
  };
  const stop = () => {
    closed = true;
    clearTimeout(timer);
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
  };
  const profile = jobMcpProfile(async () => {
    await claim.inspect();
    await authorize();
    await poll();
    controller.signal.throwIfAborted();
    const value = await acquire(host.mcp, claim.binding, {
      signal: controller.signal,
    });
    await authorize();
    controller.signal.throwIfAborted();
    await mkdir(copies, { mode: 0o700 });
    const file = join(copies, 'source.json');
    try {
      await store(file, value);
      const prepared = await load({ kind: 'delegated-http-v1', file }, {
        memberId: runner.memberId, discoveryRoot: copies,
      });
      requireThat(Object.values(prepared.configuration.mcp_servers)
        .some(server => server.enabled !== false), 'USER_MCP_NO_READ_ONLY_TOOLS');
      controller.signal.throwIfAborted();
      return prepared;
    } catch (error) {
      // Discovery may leave a session journal. Retain it for reconciliation.
      await rm(file, { force: true });
      await rmdir(copies).catch(cleanup => {
        if (cleanup.code !== 'ENOTEMPTY') throw cleanup;
      });
      throw error;
    }
  });
  try { await profile.read(); }
  catch (error) { stop(); throw error; }
  return {
    read: async () => {
      controller.signal.throwIfAborted();
      await claim.inspect();
      return profile.read();
    },
    enter: () => {
      controller.signal.throwIfAborted();
      return profile.enter();
    },
    async retire(stopped) {
      await claim.inspect();
      await profile.retire([copies], stopped);
    },
    stop,
  };
}
