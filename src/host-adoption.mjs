import { constants } from 'node:fs';
import { open, lstat, realpath } from 'node:fs/promises';
import { dirname, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GitHubReader } from './github-read.mjs';
import { verifyInstalledSource } from './source-package.mjs';
import { privateHostDirectory } from './host-fence.mjs';
import { digest, isId, requireThat } from './identity.mjs';

export const hostFile = '/etc/nibfin/host.json';
export const coreRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export async function rootOwnedPath(path) {
  requireThat(
    isAbsolute(path) && resolve(path) === path && (await realpath(path)) === path,
    'UNTRUSTED_ADOPTION_PATH',
  );
  for (let current = path; ; current = dirname(current)) {
    const stat = await lstat(current);
    requireThat(
      !stat.isSymbolicLink() && stat.uid === 0 && (stat.mode & 0o022) === 0,
      'UNTRUSTED_ADOPTION_PATH',
    );
    if (current === '/') break;
  }
}

export async function boundedHostFile(path, limit, privateFile = false) {
  requireThat(isAbsolute(path) && (await realpath(path)) === path, 'UNTRUSTED_HOST_FILE');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    requireThat(
      stat.isFile() &&
        stat.nlink === 1 &&
        stat.size <= limit &&
        (!privateFile || (stat.uid === process.getuid() && (stat.mode & 0o077) === 0)),
      'UNTRUSTED_HOST_FILE',
    );
    const bytes = await file.readFile('utf8');
    requireThat(Buffer.byteLength(bytes) <= limit, 'HOST_FILE_TOO_LARGE');
    return bytes;
  } finally {
    await file.close();
  }
}

// Arguments come only from the fixed administrative file, never a request.
export async function verifyHostInstallation(installation, approval) {
  const source = await verifyInstalledSource(installation.directory, installation.pin);
  requireThat(digest(source) === digest(approval.source), 'ADOPTED_SOURCE_MISMATCH');
}

export async function inspectHostAdoption({ host, hostBytes, adopted }) {
  await rootOwnedPath(hostFile);
  await rootOwnedPath(coreRoot);
  requireThat(
    (await boundedHostFile(hostFile, 262144)) === hostBytes,
    'HOST_ADOPTION_CHANGED',
  );
  requireThat(host.installation.directory === coreRoot, 'INVALID_HOST_ADOPTION');
  await verifyHostInstallation(host.installation, adopted.approval);
}

// Fixed administrator-owned backend. Neither entry accepts a host path,
// credential, adapter or policy from workflow inputs or event contents.
export async function loadHostAdoption(issueNumber) {
  requireThat(
    /^[1-9][0-9]*$/.test(issueNumber) && isId(Number(issueNumber)),
    'INVALID_ADOPTED_ISSUE',
  );
  requireThat(
    process.platform === 'linux' && process.getuid() > 0,
    'UNSUPPORTED_STAGE_HOST',
  );
  await rootOwnedPath(hostFile);
  await rootOwnedPath(coreRoot);
  const hostBytes = await boundedHostFile(hostFile, 256 * 1024);
  const host = JSON.parse(hostBytes),
    adopted = host.issues?.[issueNumber];
  requireThat(
    host.schemaVersion === 1 &&
      host.uid === process.getuid() &&
      host.installation?.directory === coreRoot &&
      host.kind === 'single-host-linux-v1',
    'INVALID_HOST_ADOPTION',
  );
  requireThat(
    adopted &&
      adopted.isolation?.issue?.number === Number(issueNumber) &&
      adopted.runner?.runnerId === host.runnerId &&
      adopted.runner?.memberId === host.memberId,
    'ISSUE_NOT_ADOPTED',
  );
  await inspectHostAdoption({ host, hostBytes, adopted });
  await privateHostDirectory(host.stateRoot);
  await privateHostDirectory(dirname(host.tokenFile));
  const token = (await boundedHostFile(host.tokenFile, 16384, true)).trim();
  return { host, hostBytes, adopted, token, reader: new GitHubReader(token) };
}
