import { randomUUID } from 'node:crypto';
import { requireThat } from './identity.mjs';
import { verifyNamespace } from './docker-backend.mjs';
import { managedResources as resources } from './managed-resource-contract.mjs';

// A journal is saved before create. Interrupted creates/cleanup never spawn a
// replacement probe. The administrator must reconcile any uncertain effect.
// The probe runs under the AppArmor profile its image is published with.
export async function resourceProbe(
  io, state, image, namespace, save, key, availability, profile = resources.apparmor,
) {
  requireThat(!state.probe || state.probe.phase === 'complete',
    'RESOURCE_PROBE_RECONCILIATION_REQUIRED');
  const name = `nibfin-resource-proof-${randomUUID()}`;
  const probe = state.probe = { name, image, key, phase: 'create' };
  await save();
  const docker = args => io.docker(true, args);
  const id = (await docker([
    'create', '--pull=never', '--name', name,
    '--label', `${resources.label}=${state.owner}`, '--read-only', '--network=none',
    '--ipc=none', '--cap-drop=ALL', '--security-opt=no-new-privileges',
    `--security-opt=apparmor=${profile}`, '--user=1000:1000',
    '--pids-limit=32', '--memory=128m', '--cpus=1',
    '--entrypoint=/usr/bin/sleep', image, '300',
  ])).trim();
  requireThat(/^[a-f0-9]{64}$/.test(id), 'RESOURCE_PROBE_CREATE_UNKNOWN');
  probe.id = id;
  probe.phase = 'start';
  await save();
  const inspect = async () => {
    const rows = JSON.parse(await docker(['inspect', id]));
    const row = rows[0];
    requireThat(rows.length === 1 && row.Id === id && row.Name === `/${name}` &&
      row.Image === image && row.Config?.Labels?.[resources.label] === state.owner,
    'RESOURCE_PROBE_OWNERSHIP_UNKNOWN');
    return row;
  };
  try {
    await docker(['start', id]).catch(() => {});
    const row = await inspect();
    const pid = row.State?.Pid;
    requireThat(row.State?.Running === true && Number.isSafeInteger(pid) && pid > 0,
      'RESOURCE_PROBE_START_UNKNOWN');
    probe.pid = pid;
    probe.processIdentity = await io.processIdentity(pid);
    requireThat(/^[0-9]+$/.test(probe.processIdentity ?? ''),
      'RESOURCE_PROBE_PROCESS_UNKNOWN');
    await save();
    const proof = await io.kernelProof(pid);
    verifyNamespace(proof, namespace);
    requireThat(proof.label.trim() === `${profile} (enforce)`,
      'RESOURCE_APPARMOR_NOT_ENFORCED');
    await availability();
    const after = await inspect();
    requireThat(after.State.Running === true && after.State.Pid === pid,
      'RESOURCE_PROBE_PROCESS_CHANGED');
  } finally {
    probe.phase = 'cleanup';
    await save();
    await inspect();
    await docker(['rm', '--force', id]).catch(() => {});
    const remaining = await docker([
      'ps', '-aq', '--no-trunc', '--filter', `name=^/${name}$`,
    ]);
    requireThat(remaining.trim() === '', 'RESOURCE_PROBE_CLEANUP_UNKNOWN');
    if (probe.pid) {
      requireThat(/^[0-9]+$/.test(probe.processIdentity ?? ''),
        'RESOURCE_PROBE_TERMINATION_UNKNOWN');
      await io.verifyStopped(probe.pid, probe.processIdentity);
    }
    probe.phase = 'complete';
    await save();
  }
}
