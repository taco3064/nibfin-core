import { command } from './process.mjs';
import { rootOwnedPath } from './host-paths.mjs';

export const reclamationProgram = '/opt/nibfin/core/bin/nibfin-reclaim';
export const reclamationEnvironment = Object.freeze({
  PATH: '/usr/sbin:/usr/bin:/bin', LANG: 'C',
});

// Installed Controller composition only; no paths or configuration cross sudo.
async function invoke() {
  await rootOwnedPath('/usr/bin/sudo');
  await rootOwnedPath(reclamationProgram);
  return command('/usr/bin/sudo', ['-n', '-u', 'root', '--', reclamationProgram],
    { env: reclamationEnvironment });
}

export function reclamationResult(value) {
  const statuses = ['unsupported', 'unavailable', 'success', 'failure'];
  if (!value || !statuses.includes(value.status) ||
      !['linux', 'wsl', 'unsupported'].includes(value.platform) ||
      typeof value.attempted !== 'boolean' || !Array.isArray(value.filesystems))
    throw new Error('Invalid reclamation response');
  const filesystems = value.filesystems.map(row => {
    if (!statuses.includes(row.status) || typeof row.attempted !== 'boolean' ||
        !(row.bytes === null || (Number.isSafeInteger(row.bytes) && row.bytes >= 0)))
      throw new Error('Invalid filesystem response');
    return { status: row.status, attempted: row.attempted, bytes: row.bytes };
  });
  return { status: value.status, platform: value.platform,
    attempted: value.attempted, filesystems };
}

// All errors, including malformed/unsafe output, are contained here. Neither
// stderr nor untrusted response fields can leak into Controller diagnostics.
export async function requestStorageReclamation(run = invoke) {
  try {
    const result = await run();
    return reclamationResult(JSON.parse(result.stdout.toString('utf8')));
  } catch {
    return { status: 'unavailable', platform: 'unsupported', attempted: false,
      filesystems: [] };
  }
}

export async function reportStorageReclamation(request = requestStorageReclamation) {
  if (request === false) return; // Composed cleanup requests once at its outer boundary.
  try {
    const result = reclamationResult(await request());
    console.error('Nibfin storage reclamation: ' + JSON.stringify(result));
    return result;
  } catch {
    // Reclamation and diagnostic failures never change cleanup eligibility/result.
  }
}
