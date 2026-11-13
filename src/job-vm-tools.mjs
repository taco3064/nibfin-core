import { join } from 'node:path';
import { stat, truncate } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { command } from './process.mjs';
import { containerLabelArgs } from './host-containers.mjs';

const toolDirectory = '/opt/nibfin/project';

export async function archiveJobVmTools(endpoint, image, directory, label) {
  const env = { PATH: '/usr/bin:/bin', HOME: '/nonexistent',
    DOCKER_CONFIG: '/nonexistent', LANG: 'C.UTF-8' };
  const docker = (args, options) => command(endpoint.docker,
    ['--host', 'unix://' + endpoint.socket, ...args], { env, ...options });
  const name = 'nibfin-vm-tools-' + randomUUID();
  const archive = join(directory, 'tools.tar');
  try {
    await docker(['create', '--name', name, '--pull=never', '--network', 'none',
      ...containerLabelArgs(label), '--entrypoint', '/bin/false', image]);
    await docker(['cp', name + ':' + toolDirectory, directory], { timeout: 120000 });
    await command('/usr/bin/tar', ['-cf', archive, '-C', directory, 'project'],
      { env, timeout: 120000 });
    const { size } = await stat(archive);
    // Virtio block exposes only complete sectors.
    await truncate(archive, Math.ceil(size / 512) * 512);
    return archive;
  } finally {
    const removed = await docker(['rm', '--force', name], { allowedExitCodes: [0, 1] });
    if (removed.exitCode && !removed.stderr.toString().includes('No such container'))
      throw Object.assign(new Error('JOB_VM_TOOL_CLEANUP_FAILED'), {
        code: 'JOB_VM_TOOL_CLEANUP_FAILED',
      });
  }
}
