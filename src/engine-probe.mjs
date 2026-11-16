import { readFile, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { rootOwnedPath } from './host-paths.mjs';
import { requireThat } from './identity.mjs';
import { verifyNamespace } from './docker-backend.mjs';

// A disposable local rootfs tests the daemon's kernel maps without downloading
// or provisioning product images. Only the installed sleep and its loader enter.
export async function probeRootfs(io) {
  const executable = '/usr/bin/sleep';
  await rootOwnedPath(executable);
  await rootOwnedPath('/usr/bin/ldd');
  const libraries = await io.run('/usr/bin/ldd', [executable]);
  const paths = new Set([executable]);
  for (const line of libraries.trim().split('\n')) {
    const match = /^\s*(?:[^\s]+ => )?(\/[^\s]+) \(0x[0-9a-f]+\)\s*$/.exec(line);
    if (match) paths.add(match[1]);
    else requireThat(/^\s*linux-vdso\.so\.\d+ \(0x[0-9a-f]+\)\s*$/.test(line),
      'ENGINE_PROBE_DEPENDENCIES_UNPROVEN');
  }
  const chunks = [];
  let total = 0;
  for (const path of paths) {
    requireThat(/^\/[A-Za-z0-9_./+-]+$/.test(path) && path.length < 100 &&
      !path.split('/').includes('..'), 'ENGINE_PROBE_DEPENDENCIES_UNPROVEN');
    const canonical = await realpath(path);
    await rootOwnedPath(canonical);
    const bytes = await readFile(canonical);
    total += bytes.length;
    requireThat(total <= 16 * 1024 * 1024, 'ENGINE_PROBE_ROOTFS_TOO_LARGE');
    const header = Buffer.alloc(512);
    const write = (value, offset, length) => header.write(value, offset, length, 'ascii');
    const octal = (value, offset, length) =>
      write(value.toString(8).padStart(length - 1, '0') + '\0', offset, length);
    write(path.slice(1), 0, 100);
    octal(0o755, 100, 8);
    octal(0, 108, 8);
    octal(0, 116, 8);
    octal(bytes.length, 124, 12);
    octal(0, 136, 12);
    header.fill(32, 148, 156);
    write('0', 156, 1);
    write('ustar\0', 257, 6);
    write('00', 263, 2);
    const sum = header.reduce((value, byte) => value + byte, 0);
    write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
    chunks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  return Buffer.concat([...chunks, Buffer.alloc(1024)]);
}

export function newEngineProbe() {
  const nonce = randomUUID();
  return { name: `nibfin-engine-proof-${nonce}`, tag: `nibfin-engine-proof:${nonce}` };
}

export async function verifyEngineProbe(io, probe, namespace, save) {
  const docker = (args, options) => io.docker(true, args, options);
  // Never import or run again after an interrupted command. Reconcile existing
  // named resources, retaining the intent if their identity cannot be established.
  requireThat(probe.phase === undefined, 'ENGINE_PROBE_RECONCILIATION_REQUIRED');
  probe.phase = 'import';
  await save();
  const output = (await docker(['image', 'import', '-', probe.tag], {
    input: await io.probeRootfs(),
  })).trim();
  requireThat(/^sha256:[0-9a-f]{64}$/.test(output), 'ENGINE_PROBE_IMPORT_UNKNOWN');
  probe.image = output;
  const images = JSON.parse(await docker(['image', 'inspect', output]));
  requireThat(images.length === 1 && images[0].Id === output &&
    images[0].RepoTags?.length === 1 && images[0].RepoTags[0] === probe.tag,
  'ENGINE_PROBE_IMPORT_UNKNOWN');
  probe.phase = 'create';
  await save();
  const id = (await docker([
    'create', '--pull=never', '--name', probe.name,
    '--label', `nibfin.engine-proof=${probe.name}`, '--read-only', '--network=none',
    '--ipc=none', '--cap-drop=ALL', '--security-opt=no-new-privileges',
    '--security-opt=apparmor=docker-default', '--pids-limit=16', '--memory=32m',
    '--cpus=1', '--entrypoint=/usr/bin/sleep', output, '60',
  ])).trim();
  requireThat(/^[0-9a-f]{64}$/.test(id), 'ENGINE_PROBE_CREATE_UNKNOWN');
  probe.id = id;
  probe.phase = 'start';
  await save();
  let proof;
  try {
    await docker(['start', id]).catch(() => {});
    const inspect = async () => {
      const rows = JSON.parse(await docker(['inspect', id]));
      const row = rows[0];
      requireThat(rows.length === 1 && row.Id === id && row.Image === probe.image &&
        row.Config?.Labels?.['nibfin.engine-proof'] === probe.name &&
        row.State?.Running === true && Number.isSafeInteger(row.State.Pid) &&
        row.State.Pid > 0, 'ENGINE_PROBE_START_UNKNOWN');
      return row.State.Pid;
    };
    const pid = await inspect();
    proof = await io.kernelProof(pid);
    verifyNamespace(proof, namespace);
    requireThat(proof.label.trim() === 'docker-default (enforce)',
      'ENGINE_PROBE_APPARMOR_UNPROVEN');
    requireThat(await inspect() === pid, 'ENGINE_PROBE_PROCESS_CHANGED');
  } finally {
    probe.phase = 'cleanup';
    await save();
    await cleanupEngineProbe(io, probe);
    probe.phase = 'complete';
    await save();
  }
  return proof;
}

export async function cleanupEngineProbe(io, probe) {
  const docker = args => io.docker(true, args);
  requireThat(/^nibfin-engine-proof-[a-f0-9-]{36}$/.test(probe.name) &&
    /^nibfin-engine-proof:[a-f0-9-]{36}$/.test(probe.tag) &&
    /^sha256:[a-f0-9]{64}$/.test(probe.image), 'ENGINE_PROBE_OWNERSHIP_UNPROVEN');
  const remaining = () => docker([
    'ps', '-aq', '--no-trunc', '--filter', `name=^/${probe.name}$`,
  ]);
  const id = (await remaining()).trim();
  if (id) {
    const rows = JSON.parse(await docker(['inspect', id]));
    requireThat(rows.length === 1 && rows[0].Id === id && id === probe.id &&
      rows[0].Name === `/${probe.name}` && rows[0].Image === probe.image &&
      rows[0].Config?.Labels?.['nibfin.engine-proof'] === probe.name,
    'ENGINE_PROBE_OWNERSHIP_UNPROVEN');
    await docker(['rm', '--force', id]).catch(() => {});
  }
  requireThat((await remaining()).trim() === '', 'ENGINE_PROBE_CLEANUP_UNKNOWN');
  const images = (await docker(['image', 'ls', '--no-trunc', '-q', probe.tag])).trim();
  if (images) {
    requireThat(images === probe.image, 'ENGINE_PROBE_OWNERSHIP_UNPROVEN');
    await docker(['image', 'rm', probe.tag]).catch(() => {});
  }
  requireThat((await docker(['image', 'ls', '-q', probe.tag])).trim() === '',
    'ENGINE_PROBE_CLEANUP_UNKNOWN');
}
