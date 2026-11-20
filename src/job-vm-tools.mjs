import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stat, truncate, writeFile, rm, open } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { command } from './process.mjs';
import { containerLabelArgs } from './host-containers.mjs';
import { requireThat } from './identity.mjs';

const toolDirectory = '/opt/nibfin/project';
const builder = fileURLToPath(new URL('./job-vm-payload.py', import.meta.url));
const env = { PATH: '/usr/bin:/bin', HOME: '/nonexistent',
  DOCKER_CONFIG: '/nonexistent', LANG: 'C.UTF-8', PYTHONDONTWRITEBYTECODE: '1' };

// Copy without following image links. The archive is validated before it can
// reach either a host filesystem or the guest runtime extraction path.
export async function archiveJobVmTools(endpoint, image, directory, label) {
  const docker = (args, options) => command(endpoint.docker,
    ['--host', 'unix://' + endpoint.socket, ...args], { env, ...options });
  const name = 'nibfin-vm-tools-' + randomUUID();
  const archive = join(directory, 'project.tar');
  try {
    await docker(['create', '--name', name, '--pull=never', '--network', 'none',
      ...containerLabelArgs(label), '--entrypoint', '/bin/false', image]);
    // Docker cp writes a tar stream to stdout; it does not extract on the host.
    await copyArchive(endpoint, name, archive);
    return archive;
  } finally {
    const removed = await docker(['rm', '--force', name], { allowedExitCodes: [0, 1] });
    if (removed.exitCode && !removed.stderr.toString().includes('No such container'))
      throw Object.assign(new Error('JOB_VM_TOOL_CLEANUP_FAILED'), {
        code: 'JOB_VM_TOOL_CLEANUP_FAILED',
      });
  }
}

async function copyArchive(endpoint, name, archive) {
  const output = await open(archive, 'wx', 0o600);
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(endpoint.docker, ['--host', 'unix://' + endpoint.socket,
        'cp', name + ':' + toolDirectory, '-'], {
        shell: false, env, stdio: ['ignore', output.fd, 'ignore'],
      });
      child.once('error', reject);
      child.once('close', code => {
        if (code === 0) resolve();
        else reject(Object.assign(new Error('JOB_VM_TOOL_ARCHIVE_FAILED'), {
          code: 'JOB_VM_TOOL_ARCHIVE_FAILED',
        }));
      });
    });
  } finally { await output.close(); }
}

export async function buildJobVmPayload(directory, executor, tools, {
  archiveTools = archiveJobVmTools, run = command, python = '/usr/bin/python3',
} = {}) {
  requireThat(Buffer.isBuffer(executor) && executor.length > 0,
    'JOB_VM_EXECUTOR_SNAPSHOT_REQUIRED');
  const snapshot = join(directory, 'executor.snapshot');
  const archive = join(directory, 'runtime.tar');
  let project;
  try {
    await writeFile(snapshot, executor, { flag: 'wx', mode: 0o600 });
    if (tools) project = await archiveTools(
      tools.endpoint, tools.image, directory, tools.label);
    const result = await run(python, [builder, snapshot, project ?? '-', archive],
      { env, allowedExitCodes: [0, 1] });
    if (result.exitCode !== 0) {
      const failure = JSON.parse(result.stdout.toString());
      requireThat(['JOB_VM_PAYLOAD_UNSAFE', 'JOB_VM_PAYLOAD_IO_FAILED']
        .includes(failure.code), 'JOB_VM_PAYLOAD_BUILD_FAILED');
      throw Object.assign(new Error(failure.code), failure);
    }
    const { size } = await stat(archive);
    await truncate(archive, Math.ceil(size / 512) * 512);
    return archive;
  } finally {
    await rm(snapshot, { force: true });
    if (project) await rm(project, { force: true });
  }
}
