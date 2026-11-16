import { lstat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { boundedHostFile, hostFile, coreRoot } from './host-adoption.mjs';
import { rootOwnedPath } from './host-paths.mjs';
import { controllerRoute } from './controller-contract.mjs';
import { verifyInstalledSource } from './source-package.mjs';
import { sharedRepository, sharedRunner } from './shared-runner.mjs';
import { digest, isId, isSha, requireThat } from './identity.mjs';
import { RelayReader } from './relay-http.mjs';
import { observeRelayOrigin } from './relay-observe.mjs';
import { sharedDispatchWorkflow } from './shared-runner.mjs';
import { RelayJournal } from './relay-state.mjs';

export const relayConfigFile = '/etc/nibfin/notification-relay.json';
export const relayStateRoot = '/var/lib/nibfin/notification-relay';
export const relayUnitDirectory = '/etc/systemd/system';
export const relayUnits = ['nibfin-notification-relay.service',
  'nibfin-notification-relay.timer'];

export function validateRelayConfiguration(value) {
  requireThat(value?.schemaVersion === 1 && Object.keys(value).sort().join(',') ===
    'origins,schemaVersion' && Array.isArray(value.origins) &&
    value.origins.length > 0 && value.origins.length <= 10,
  'INVALID_RELAY_CONFIGURATION');
  const ids = new Set();
  for (const origin of value.origins) {
    const workflow = origin?.workflow;
    requireThat(Object.keys(origin).sort().join(',') ===
      'ref,repository,repositoryId,workflow' && isId(origin.repositoryId) &&
      !ids.has(origin.repositoryId) && typeof origin.repository === 'string' &&
      typeof origin.ref === 'string' && origin.ref.length > 0 &&
      origin.ref.length <= 255 && !/[\x00-\x20]/.test(origin.ref) &&
      workflow && Object.keys(workflow).sort().join(',') === 'blob,commit,id,path' &&
      isId(workflow.id) && isSha(workflow.commit) && isSha(workflow.blob) &&
      workflow.path === '.github/workflows/nibfin-issue.yml',
    'INVALID_RELAY_CONFIGURATION');
    ids.add(origin.repositoryId);
  }
  return value;
}

export function bindRelayOrigin(host, target, origin) {
  const adopted = target.repository;
  const event = adopted?.eventRunner;
  const workflow = origin.workflow;
  requireThat(target.uid === host.uid && target.memberId === host.memberId &&
    target.stateRoot === host.stateRoot &&
    digest(target.installation) === digest(host.installation) &&
    adopted?.approval.repositoryId === origin.repositoryId &&
    adopted.approval.repository === origin.repository &&
    event?.repositoryId === origin.repositoryId &&
    event.repository === origin.repository &&
    event.workflowId === workflow.id && event.workflowPath === workflow.path &&
    event.sourceCommit === workflow.commit && event.workflowBlob === workflow.blob &&
    event.reusable?.repository === 'taco3064/nibfin-core' &&
    event.reusable.path === '.github/workflows/issue.yml' &&
    event.reusable.commit === host.installation.pin.commit,
  'RELAY_ORIGIN_NOT_ADOPTED');
  return sharedRunner(host, origin).runner;
}

// Fixed host files only. No workspace, artifact or CLI argument chooses a token/path.
export async function loadRelayHost({ authenticate = true, verifyRemote = true } = {}) {
  requireThat(process.platform === 'linux' && process.getuid() === 0 &&
    coreRoot === '/opt/nibfin/core', 'RELAY_REQUIRES_INSTALLED_ADMINISTRATOR');
  const snapshots = new Map();
  const read = async path => {
    await rootOwnedPath(path);
    const bytes = await boundedHostFile(path, 262144);
    snapshots.set(path, bytes);
    return JSON.parse(bytes);
  };
  const host = await read(hostFile);
  requireThat(host.schemaVersion === 1 && host.kind === 'single-host-linux-v1' &&
    host.installation?.directory === coreRoot && controllerRoute(host) &&
    isId(host.memberId), 'INVALID_HOST_ADOPTION');
  const config = validateRelayConfiguration(await read(relayConfigFile));
  await rootOwnedPath(coreRoot);
  await rootOwnedPath('/usr/bin/flock');
  await verifyInstalledSource(coreRoot, host.installation.pin);
  let runner;
  for (const origin of config.origins) {
    const target = await sharedRepository(host, origin.repositoryId, read);
    const { target: unused, ...selected } = bindRelayOrigin(host, target, origin);
    void unused;
    requireThat(!runner || digest(runner) === digest(selected),
      'RELAY_DESTINATION_CONFLICT');
    runner = selected;
  }
  // sharedRunner embeds the current target. It is irrelevant to the destination guard.
  const destination = runner;
  const inspect = async () => {
    for (const [path, bytes] of snapshots) {
      await rootOwnedPath(path);
      requireThat(await boundedHostFile(path, 262144) === bytes, 'HOST_ADOPTION_CHANGED');
    }
    await rootOwnedPath(coreRoot);
    await verifyInstalledSource(coreRoot, host.installation.pin);
  };
  const configuration = { ...config, memberId: host.memberId,
    coreCommit: host.installation.pin.commit, runner: destination };
  const journal = new RelayJournal(relayStateRoot);
  if (!authenticate) return { host, configuration, journal, inspect };
  // The existing Controller credential boundary: private directory and member UID.
  for (const path of [dirname(host.tokenFile), host.tokenFile]) {
    const stat = await lstat(path);
    requireThat(stat.uid === host.uid && (stat.mode & 0o077) === 0 &&
      (path === host.tokenFile ? stat.isFile() && stat.nlink === 1 : stat.isDirectory()),
    'CONTROLLER_CREDENTIAL_NOT_PRIVATE');
  }
  const token = (await boundedHostFile(host.tokenFile, 16384)).trim();
  const tokenIdentity = await lstat(host.tokenFile, { bigint: true });
  const reader = new RelayReader(token);
  const actor = verifyRemote ? await reader.get('/user') : null;
  requireThat(!verifyRemote || actor.id === host.memberId && actor.type === 'User',
    'RELAY_CONTROLLER_CHANGED');
  const remote = verifyRemote ? await sharedDispatchWorkflow(reader, destination) : null;
  for (const origin of verifyRemote ? config.origins : [])
    await observeRelayOrigin(reader, origin, configuration.coreCommit);
  const inspectCredential = async () => {
    await inspect();
    const current = await lstat(host.tokenFile, { bigint: true });
    requireThat(current.ino === tokenIdentity.ino && current.dev === tokenIdentity.dev &&
      current.mtimeNs === tokenIdentity.mtimeNs &&
      current.ctimeNs === tokenIdentity.ctimeNs,
    'RELAY_CREDENTIAL_CHANGED');
  };
  await inspectCredential();
  return { host, configuration, journal, token, reader, inspect: inspectCredential,
    ...(verifyRemote ? { verified: {
      controller: { id: actor.id, login: actor.login }, destination: remote,
      origins: config.origins } } : {}) };
}
