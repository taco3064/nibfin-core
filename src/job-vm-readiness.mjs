import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { join } from 'node:path';
import { runJobVm } from './job-vm.mjs';
import { acquireWriterCapacity } from './job-vm-pressure.mjs';
import { buildJobVmPayload } from './job-vm-tools.mjs';
import { guestWorkspace } from './job-vm-guest-workspace.mjs';
import { openJobVmExecRelay, probeJobVmExecutor } from './job-vm-exec-relay.mjs';
import { validateJobVmWorkspace } from './job-vm-workspace.mjs';
import { projectToolDirectories, projectToolRoot } from './project-tool-paths.mjs';
import { deliveryRoleTimeout } from './process.mjs';
import { requireThat } from './identity.mjs';
import { jobVmReadinessConsole } from './job-vm-readiness-console.mjs';

const source = Object.freeze({ path: 'retained-source', executable: false,
  content: Buffer.from('source must survive readiness\n').toString('base64') });

export async function verifyGuestReadiness(connect, directory, signal, {
  workspace = guestWorkspace, openRelay = openJobVmExecRelay,
  probe = probeJobVmExecutor,
} = {}) {
  const work = workspace(connect, signal);
  const id = randomUUID();
  await work.prepare('work', [source], {
    root: projectToolRoot(true, id).slice(6),
    directories: projectToolDirectories(true, id).map(path => path.slice(6)),
  });
  await work.prepare('main', []);
  await work.prepare('input', []);
  await work.exercise();
  const relay = join(directory, 'exec.sock');
  const close = await openRelay(relay, connect);
  try { await probe(relay, signal); }
  finally { await close(); }
  const files = await work.collect();
  validateJobVmWorkspace(files);
  requireThat(isDeepStrictEqual(files, [source]), 'JOB_VM_READINESS_CONTENT_CHANGED');
}

export async function runJobVmReadiness(config, executor, {
  runVm = runJobVm, capacity = acquireWriterCapacity, prepare = buildJobVmPayload,
  verify = verifyGuestReadiness,
} = {}) {
  const abort = new AbortController();
  const cancel = () => abort.abort(Object.assign(new Error('JOB_VM_CANCELLED'), {
    code: 'JOB_VM_CANCELLED',
  }));
  const signal = AbortSignal.any([
    abort.signal, AbortSignal.timeout(deliveryRoleTimeout),
  ]);
  const startup = jobVmReadinessConsole();
  process.on('SIGTERM', cancel);
  process.on('SIGINT', cancel);
  let release;
  try {
    release = await capacity(config, signal);
    await runVm(config, { signal, observeConsole: startup.observe,
      prepareTools: directory => prepare(directory, executor),
      useGuest: (connect, directory) => verify(connect, directory, signal),
    });
    return { status: 'ready' };
  } catch (error) {
    throw startup.failure(error);
  } finally {
    process.off('SIGTERM', cancel);
    process.off('SIGINT', cancel);
    await release?.();
  }
}
