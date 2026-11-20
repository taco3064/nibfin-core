import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { admitRolloutManager } from './rollout-manager-context.mjs';
import { installedSharedRuntime } from './shared-platform.mjs';
import { currentPoolRuntime } from './core-only-runtime.mjs';
import { maintenanceInvoker, maintenanceRequest } from './core-maintenance-request.mjs';
import { observeCoreMaintenanceWorker } from './core-maintenance-worker.mjs';
import { sharedWorkerReader } from './security/shared-worker-reader.mjs';
import { rootOwnedPath } from './host-paths.mjs';
import { hostFile } from './host-adoption.mjs';
import { requireThat, isId } from './identity.mjs';
import { verifySharedSlotIdentity } from './shared-slot-identity.mjs';
import { inspectInstalledRunnerIdentity } from './installed-runner-state.mjs';
import { writeCommandResult } from './command-result.mjs';
import { installCoreMaintenanceEntries, observeMaintenancePrograms }
  from './core-maintenance-install.mjs';
import { rolloutFailure, readRolloutProcessResult } from './core-rollout-result.mjs';
import { observeUpgradeWorker } from './upgrade-continuation-identity.mjs';
import { upgradeManagerRequest } from './upgrade-continuation-manager.mjs';
import upgrade from './upgrade-continuation-contract.json' with { type: 'json' };
import { requireNoRetirement, requirePoolOpen } from './retirement-admission.mjs';
import { scheduleAdministratorMaintenance } from './core-maintenance-schedule-host.mjs';
import { workflowDispatchFailure } from './native-workflow-dispatch.mjs';

function execute(program, arguments_, input,
  { legacyDiagnostic = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, arguments_, {
      shell: false,
      env: { PATH: '/usr/bin:/bin', LANG: 'C', SUDO_UID: process.env.SUDO_UID ?? '' },
      stdio: ['pipe', 'pipe', legacyDiagnostic ? 4 : 'pipe'],
    });
    const chunks = [];
    const errors = [];
    child.stdout.on('data', bytes => chunks.push(bytes));
    child.stderr?.on('data', bytes => errors.push(bytes));
    child.once('error', reject);
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    child.once('close', code => resolve({ code,
      bytes: Buffer.concat(chunks).toString(),
      stderr: Buffer.concat(errors).toString() }));
  });
}

async function officialWorker(context, host, uid) {
  const index = maintenanceInvoker(host, uid);
  const primary = host.sharedRunner.runner;
  const runner = index ? host.sharedRunner.additionalRunner :
    { id: primary.runnerId, name: primary.runnerName };
  const slot = `/var/lib/nibfin/runners/slot-${index + 1}`;
  requireThat(process.cwd() === join(slot, 'bin'), 'SHARED_WORKER_SLOT_MISMATCH');
  const local = await verifySharedSlotIdentity(slot, runner, primary.repository);
  const runtime = await currentPoolRuntime(context);
  await inspectInstalledRunnerIdentity(slot, local, runtime.target,
    { bootstrapVersion: runtime.bootstrapVersion });
  return { slot, runtime, index };
}

async function preWorker(context, host, supplied, uid) {
  requireThat(typeof supplied.frame === 'string', 'SHARED_WORKER_FRAME_INVALID');
  const body = Buffer.from(supplied.frame, 'base64');
  const message = JSON.parse(new TextDecoder('utf-16le', { fatal: true }).decode(body));
  const { runtime, index, slot } = await officialWorker(context, host, uid);
  await observeMaintenancePrograms(context, [slot], { transition: true });
  if (message.jobDisplayName === 'core-maintenance') {
    await observeCoreMaintenanceWorker(context, host, message, uid,
      sharedWorkerReader(message.variables?.['system.github.token']));
  } else if (message.jobDisplayName === upgrade.execution.job) {
    await requireNoRetirement({ rollout: true });
    await requirePoolOpen();
    await observeUpgradeWorker(context, host, message, uid,
      sharedWorkerReader(message.variables?.['system.github.token']));
  } else {
    // Ordinary issue admission stays with the actual installed Core and its
    // original Runner identity. Root does not turn a maintenance flag into access.
    requireThat(runtime.directory === '/opt/nibfin/core', 'SHARED_WORKER_CORE_PENDING');
    const manifest = JSON.parse(await readFile(
      '/opt/nibfin/core/nibfin-manifest.json', 'utf8'));
    const report = 'src/security/shared-worker-report.mjs';
    const typed = manifest.files.some(file => file.path === report);
    const entry = '/opt/nibfin/core/' + (typed ? report :
      'src/security/shared-worker-entry.mjs');
    await rootOwnedPath('/usr/sbin/runuser');
    const result = await execute('/usr/sbin/runuser',
      ['-u', `nibfin-runner-${index + 1}`, '--', runtime.target.nodePath, entry], body,
    { legacyDiagnostic: !typed });
    if (typed) {
      const value = readRolloutProcessResult(result.bytes, '', result.code);
      if (value.status !== 'admitted') return value;
    } else requireThat(result.code === 0, 'SHARED_WORKER_ADMISSION_FAILED');
  }
  return { status: 'admitted' };
}

async function main() {
  await installedSharedRuntime();
  const context = await admitRolloutManager();
  await rootOwnedPath(hostFile);
  const host = JSON.parse(await readFile(hostFile, 'utf8'));
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const supplied = JSON.parse(Buffer.concat(chunks).toString());
  const rawUid = process.env.SUDO_UID ?? '';
  requireThat(rawUid === '' || /^(0|[1-9][0-9]*)$/.test(rawUid),
    'CORE_MAINTENANCE_INVOKER_CHANGED');
  const uid = rawUid === '' ? 0 : Number(rawUid);
  requireThat(uid === 0 || isId(uid), 'CORE_MAINTENANCE_INVOKER_CHANGED');
  if (supplied.kind === 'pre-worker') return preWorker(context, host, supplied, uid);
  if (typeof supplied.kind === 'string' && supplied.kind.startsWith('upgrade-'))
    return upgradeManagerRequest(context, host, supplied, uid, execute);
  let request;
  let arguments_;
  if (supplied.kind === 'maintenance') {
    request = await maintenanceRequest(context, host, supplied, uid,
      sharedWorkerReader({ isSecret: true, value: supplied.githubToken }));
    arguments_ = ['--core-only'];
  } else {
    requireThat(['administrator', 'prepare', 'inspect'].includes(supplied.kind) &&
      uid !== host.runnerUid && uid !== host.sharedRunner.additionalRunner.uid &&
      !/nibfin-shared-runner@(?:1|2)\.service/.test(
        await readFile('/proc/self/cgroup', 'utf8')),
    'CORE_MAINTENANCE_ADMINISTRATOR_REQUIRED');
    if (supplied.kind === 'prepare' || supplied.kind === 'inspect')
      return installCoreMaintenanceEntries(context,
        { inspectOnly: supplied.kind === 'inspect' });
    requireThat(supplied.coreOnly === undefined || typeof supplied.coreOnly === 'boolean',
      'CORE_MAINTENANCE_REQUEST_INVALID');
    if (supplied.coreOnly) {
      requireThat(isId(supplied.target?.runId) && isId(supplied.target?.artifactId),
        'CORE_MAINTENANCE_TARGET_REQUIRED');
      return scheduleAdministratorMaintenance(context, host, supplied.target);
    }
    arguments_ = [];
  }
  requireThat(isId(supplied.target?.runId) && isId(supplied.target?.artifactId),
    'CORE_MAINTENANCE_TARGET_REQUIRED');
  const script = join(context.codeRoot, 'scripts/core-rollout-admin.py');
  const result = await execute('/usr/bin/python3', [script, ...arguments_,
    String(supplied.target.runId), String(supplied.target.artifactId)],
  request ? JSON.stringify(request) : '');
  return readRolloutProcessResult(result.bytes, '', result.code);
}

try { writeCommandResult(await main()); }
catch (error) {
  writeCommandResult(workflowDispatchFailure(error) ?? rolloutFailure(error));
}
