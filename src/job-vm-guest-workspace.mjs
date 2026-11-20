import { requireThat } from './identity.mjs';
import { exchangeJobVmFrame } from './job-vm-channel.mjs';
import { requireJobVmToolOutput } from './job-vm-workspace.mjs';

const workspacePort = 4020;

export function guestWorkspace(connect, signal) {
  const request = async payload => {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
    const connection = await connect(workspacePort, deadline);
    return exchangeJobVmFrame(connection, payload, deadline);
  };
  return {
    async prepare(name, files, output) {
      const result = await request({ operation: 'prepare', name, files,
        ...(output ? { toolRoot: output.root, toolDirectories: output.directories } : {}),
      });
      requireThat(result?.ready === true, 'JOB_VM_WORKSPACE_TRANSFER_FAILED');
      if (output) requireJobVmToolOutput(result, output.root, output.directories);
    },
    async exercise() {
      const result = await request({ operation: 'exercise-readiness' });
      requireThat(result?.written === true, 'JOB_VM_READINESS_EFFECT_UNAVAILABLE');
    },
    async collect() {
      const result = await request({ operation: 'collect' });
      requireThat(Array.isArray(result?.files), 'JOB_VM_WORKSPACE_TRANSFER_FAILED');
      return result.files;
    },
  };
}
