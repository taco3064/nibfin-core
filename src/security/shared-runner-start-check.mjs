import { verifySharedSlotIdentity } from '../shared-slot-identity.mjs';
import { requirePoolOpen } from '../retirement-admission.mjs';
import { installedProvider } from '../provider-binding.mjs';
import { access, constants, lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { boundedHostFile, hostFile } from '../host-adoption.mjs';
import { rootOwnedPath } from '../host-paths.mjs';
import { controllerRoute } from '../controller-contract.mjs';
import { requireThat } from '../identity.mjs';
import { installedSharedRuntime, verifySharedFile } from '../shared-platform.mjs';

async function check() {
  await requirePoolOpen();
  const slot = process.argv[2];
  requireThat(slot === '1' || slot === '2', 'INVALID_SHARED_RUNNER_SLOT');
  await rootOwnedPath(hostFile);
  const host = JSON.parse(await boundedHostFile(hostFile, 256 * 1024));
  installedProvider(host);
  const second = host.sharedRunner?.additionalRunner;
  const primary = host.sharedRunner?.runner;
  requireThat(controllerRoute(host) && primary && second &&
    process.getuid() === (slot === '1' ? host.runnerUid : second.uid),
  'SHARED_RUNNER_ACCOUNT_MISMATCH');
  const directory = `/var/lib/nibfin/runners/slot-${slot}`;
  const expected = slot === '1'
    ? { id: primary.runnerId, name: primary.runnerName } : second;
  await checkSharedRunnerSlot(directory, expected, primary.repository);
  for (const path of [host.stateRoot, host.tokenFile, host.authFile,
    '/run/nibfin-engine/docker.sock']) {
    await requireDenied(path, constants.R_OK);
    await requireDenied(path, constants.W_OK);
  }
  await requireDenied(host.stateRoot, constants.X_OK);
  await checkWslMounts();
}

export async function checkSharedRunnerSlot(
  directory, expected, repository,
  { checkAccess = true, group = checkAccess ? process.getgid() : undefined,
    uid = checkAccess ? process.getuid() : undefined, target } = {},
) {
  target ??= await installedSharedRuntime();
  const dispatcher = join(directory, 'bin', 'Runner.Worker');
  const packaged = new URL('./shared-worker-dispatcher.sh', import.meta.url);
  const local = await verifySharedSlotIdentity(directory, expected, repository);
  const credentialPath = join(directory, '.credentials');
  await rootOwnedPath(credentialPath);
  const credential = JSON.parse((await boundedHostFile(credentialPath, 65536))
    .replace(/^\uFEFF/, ''));
  checkRegistrationEndpoints(local, credential);
  await rootOwnedPath(fileURLToPath(packaged));
  await rootOwnedPath('/usr/bin');
  const python = await realpath('/usr/bin/python3');
  requireThat(/^\/usr\/bin\/python3\.\d+$/.test(python),
    'SHARED_RUNNER_WORKER_ADMISSION_REQUIRED');
  await rootOwnedPath(python);
  await verifySharedFile(join(directory, 'bin', 'Runner.Listener'),
    target.listenerSha256, target);
  await verifySharedFile(join(directory, 'bin', 'Runner.Worker.official'),
    target.workerSha256, target);
  await verifyProgramTree(join(directory, 'bin'));
  await verifyProgramTree(join(directory, 'externals'));
  for (const name of ['.credentials', '.credentials_rsaparams']) {
    const path = join(directory, name);
    await rootOwnedPath(path);
    const stat = await lstat(path);
    requireThat(stat.isFile() && stat.nlink === 1 &&
      (group === undefined || stat.gid === group) &&
      (stat.mode & 0o777) === 0o640,
      'SHARED_RUNNER_CREDENTIAL_PERMISSIONS');
    if (checkAccess) await access(path, constants.R_OK);
  }
  for (const name of ['.env', '.path']) {
    const path = join(directory, name);
    if (await lstat(path).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    })) await rootOwnedPath(path);
  }
  for (const name of ['_work', '_diag']) {
    const stat = await lstat(join(directory, name));
    requireThat(stat.isDirectory() && (stat.mode & 0o777) === 0o700 &&
      (uid === undefined || stat.uid === uid) &&
      (group === undefined || stat.gid === group),
    'SHARED_RUNNER_WORK_DIRECTORY_PERMISSIONS');
  }
  requireThat(local.disableUpdate === true &&
    (await lstat(join(directory, 'bin', 'Runner.Worker.official'))).isFile() &&
    await boundedHostFile(dispatcher, 4096) === await readFile(packaged, 'utf8'),
  'SHARED_RUNNER_WORKER_ADMISSION_REQUIRED');
}

export function checkRegistrationEndpoints(settings, credential) {
  const allows = (value, host, path) => {
    if (typeof value !== 'string') return false;
    const parsed = URL.parse(value);
    return parsed && parsed.href === value && parsed.protocol === 'https:' &&
      !parsed.username && !parsed.password && !parsed.port && !parsed.search &&
      !parsed.hash && host.test(parsed.hostname) && path.test(parsed.pathname);
  };
  const pipeline = /^pipelinesghub[a-z0-9]+\.actions\.githubusercontent\.com$/;
  const broker = /^broker\.actions\.githubusercontent\.com$/;
  const oauth = /^tokenghub\.actions\.githubusercontent\.com$/;
  const tokenPath = /^\/_apis\/oauth2\/token\/[A-Za-z0-9-]+$/;
  const validOAuth = value => allows(value, oauth, tokenPath);
  requireThat(allows(settings.serverUrl, pipeline, /^\/[A-Za-z0-9-]+\/?$/) &&
    allows(settings.serverUrlV2, broker, /^\/$/) && settings.useV2Flow === true &&
    credential?.scheme === 'OAuth' && validOAuth(credential.data?.authorizationUrl) &&
    (credential.data.authorizationUrlV2 === undefined ||
      validOAuth(credential.data.authorizationUrlV2)),
  'UNTRUSTED_SHARED_RUNNER_PROVIDER_ENDPOINT');
}

async function verifyProgramTree(directory, root = directory) {
  await rootOwnedPath(directory);
  for (const name of await readdir(directory)) {
    const path = join(directory, name);
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) {
      const target = await realpath(path);
      requireThat(stat.uid === 0 && target.startsWith(`${root}/`),
        'SHARED_RUNNER_WORKER_ADMISSION_REQUIRED');
      await rootOwnedPath(target);
      continue;
    }
    requireThat(stat.uid === 0 && (stat.mode & 0o022) === 0 &&
      (stat.isFile() || stat.isDirectory()), 'SHARED_RUNNER_WORKER_ADMISSION_REQUIRED');
    if (stat.isDirectory()) await verifyProgramTree(path, root);
  }
}

async function requireDenied(path, mode) {
  try { await access(path, mode); }
  catch (err) {
    if (err.code === 'EACCES') return;
    throw err;
  }
  requireThat(false, 'SHARED_RUNNER_CAN_ACCESS_CONTROLLER_RESOURCE');
}

async function checkWslMounts() {
  const kernel = await readFile('/proc/sys/kernel/osrelease', 'utf8');
  if (!/microsoft.*wsl2/i.test(kernel)) return;
  for (const path of ['/init', '/mnt/c', '/mnt/wslg', '/run/WSL', '/dev/dxg']) {
    for (const mode of [constants.R_OK, constants.X_OK, constants.W_OK]) {
      try { await access(path, mode); }
      catch (error) {
        if (error.code === 'EACCES' || error.code === 'ENOENT') continue;
        throw error;
      }
      requireThat(false, 'SHARED_RUNNER_WSL_MOUNT_ACCESSIBLE');
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  check().catch(error => {
    const safe = ['INVALID_SHARED_RUNNER_SLOT', 'SHARED_RUNNER_ACCOUNT_MISMATCH',
      'SHARED_RUNNER_REGISTRATION_MISMATCH', 'SHARED_RUNNER_WORKER_ADMISSION_REQUIRED',
      'SHARED_RUNNER_CREDENTIAL_PERMISSIONS',
      'SHARED_RUNNER_CAN_ACCESS_CONTROLLER_RESOURCE',
      'SHARED_RUNNER_WSL_MOUNT_ACCESSIBLE'];
    process.stderr.write((safe.includes(error.code) ? error.code :
      'SHARED_RUNNER_START_CHECK_FAILED') + '\n');
    process.exitCode = 1;
  });
}
