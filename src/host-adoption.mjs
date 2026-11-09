import { constants } from 'node:fs';
import { open, lstat, realpath } from 'node:fs/promises';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repositoryIssuePin } from './repository-admission.mjs';
import { GitHubReader } from './github-read.mjs';
import { verifyInstalledSource } from './source-package.mjs';
import { privateHostDirectory } from './host-fence.mjs';
import { digest, isId, isSha, requireThat } from './identity.mjs';
import { rootOwnedPath } from './host-paths.mjs';
import { controllerRoute } from './controller-contract.mjs';
import { verifyControllerSeparation } from './controller-separation.mjs';
export { rootOwnedPath } from './host-paths.mjs';

export const hostFile = '/etc/nibfin/host.json';
export const coreRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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

export async function readGlobalInstructions(host) {
  const configured = host.globalInstructionsFile;
  const home = host.mcp?.home;
  if (configured === undefined && typeof home !== 'string') return undefined;
  try {
    return await boundedHostFile(configured ?? join(home, 'AGENTS.md'), 32 * 1024);
  } catch (error) {
    if (configured === undefined && error.code === 'ENOENT') return undefined;
    throw Object.assign(
      new Error('Global instructions could not be read', { cause: error }),
      { code: 'GLOBAL_INSTRUCTIONS_UNAVAILABLE' },
    );
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
  await verifyControllerSeparation(host);
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
  const host = JSON.parse(hostBytes);
  controllerRoute(host);
  requireThat(
    host.schemaVersion === 1 &&
      host.uid === process.getuid() &&
      host.installation?.directory === coreRoot &&
      host.kind === 'single-host-linux-v1',
    'INVALID_HOST_ADOPTION',
  );
  await privateHostDirectory(host.stateRoot);
  await privateHostDirectory(dirname(host.tokenFile));
  const token = (await boundedHostFile(host.tokenFile, 16384, true)).trim();
  const reader = new GitHubReader(token);
  let adopted = host.issues?.[issueNumber];
  if (!adopted && host.repository) {
    const template = host.repository;
    const issue = {
      repository: template.runner.repository,
      repositoryId: template.runner.repositoryId,
      number: Number(issueNumber),
    };
    issue.id = (await reader.issue(issue)).node_id;
    adopted = {
      ...template,
      approval: repositoryIssuePin(template.approval, issue),
      isolation: { ...template.isolation, issue },
    };
  }
  requireThat(
    adopted &&
      adopted.isolation?.issue?.number === Number(issueNumber) &&
      adopted.runner?.runnerId === host.runnerId &&
      adopted.runner?.memberId === host.memberId,
    'ISSUE_NOT_ADOPTED',
  );
  if (adopted.runner.actionCommit !== undefined) {
    requireThat(
      isSha(adopted.runner.actionCommit) &&
        adopted.runner.actionCoreCommit === host.installation.pin.commit &&
        !adopted.runner.reusable &&
        !adopted.runner.wakeWorkflow,
      'INVALID_ACTION_HOST_ADOPTION',
    );
  }
  await inspectHostAdoption({ host, hostBytes, adopted });
  return { host, hostBytes, adopted, token, reader };
}
