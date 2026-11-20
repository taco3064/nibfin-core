import { inspectAdoptedSource } from './adopted-source-path.mjs';
import { managerPin } from './rollout-manager-context.mjs';
import contract from './core-maintenance-installation.json' with { type: 'json' };
import { realpath } from 'node:fs/promises';
import { dirname, join, isAbsolute, resolve } from 'node:path';
import { boundedHostFile } from './host-adoption.mjs';
import { rootOwnedPath } from './host-paths.mjs';
import { sharedRepository } from './shared-runner.mjs';
import { optionalStat, readRetirementFile } from './retirement-files.mjs';
import { retirementPath, drainPath } from './retirement-admission.mjs';
import { rolloutPlanPath } from './rollout-admission.mjs';
import { rolloutPackagePaths } from './rollout-package-paths.mjs';
import { requireThat } from './identity.mjs';
import { withinPackage } from './package-use.mjs';

async function readPackageRecovery(path) {
  if (!await optionalStat(path)) return null;
  const value = await readRetirementFile(path);
  requireThat(value !== null, 'PACKAGE_RECOVERY_OBSERVATION_UNCERTAIN');
  return value;
}

// Only administrator-owned adoption and recovery documents enter this reader.
// A missing file is authoritative absence; a failed read remains uncertainty.
export async function observePackageBindings(context, {
  read = readPackageRecovery, canonical = realpath,
  selectSource = inspectAdoptedSource,
  readPeer = async path => {
    await rootOwnedPath(path);
    return JSON.parse(await boundedHostFile(path, 262144));
  },
} = {}) {
  await context.inspect();
  const host = context.host, parent = dirname(host.installation.directory);
  const documents = [host], paths = [host.installation.directory];
  for (const id of host.sharedRunner?.repositories ?? [])
    documents.push(await sharedRepository(host, id, readPeer));
  // Read every declared peer, including peers outside sharedRunner membership.
  for (const path of host.wakePeerFiles ?? []) {
    requireThat(/^\/etc\/nibfin\/host\.[A-Za-z0-9_-]+\.json$/.test(path),
      'INVALID_WAKE_PEER_PATH');
    documents.push(await readPeer(path));
  }
  const plan = await read(rolloutPlanPath);
  if (plan) {
    paths.push(...Object.values(rolloutPackagePaths(plan, parent)));
    documents.push(plan);
    // Both current and next bytes include resource bindings as well as hosts.
    for (const target of [...(plan.apply?.targets ?? []),
      ...(plan.apply?.resources ?? [])]) {
      for (const key of ['current', 'next'])
        if (target[key] !== null && target[key] !== undefined)
          documents.push(JSON.parse(target[key]));
    }
  }
  // Management and bootstrap select executable recovery source through the
  // same adopted-source contract as their real callers. Their own copied trees
  // and historical pins alone do not protect every package sharing a commit.
  for (const pinPath of [managerPin, contract.bootstrapPin]) {
    const pin = await read(pinPath);
    if (!pin) continue;
    try { paths.push((await selectSource(pin)).path); }
    catch (error) {
      if (error.code !== 'ROLLOUT_MANAGER_HOST_SOURCE_MISMATCH') throw error;
    }
  }
  const retirement = await read(retirementPath), drain = await read(drainPath);
  if (drain) documents.push(drain);
  if (retirement) {
    if (retirement.phase !== 'retired' || retirement.replacement?.phase !== 'released')
      documents.push(retirement);
    else if (retirement.replacement.bytes)
      documents.push(JSON.parse(retirement.replacement.bytes));
  }
  // Visit embedded adoption bytes without exposing any document in diagnostics.
  const strings = [];
  const visit = value => {
    if (typeof value === 'string') {
      strings.push(value);
      if (value.trim().startsWith('{') || value.trim().startsWith('['))
        visit(JSON.parse(value));
    } else if (value && typeof value === 'object')
      for (const child of Object.values(value)) visit(child);
  };
  documents.forEach(visit);
  for (const value of [...strings]) {
    if (!isAbsolute(value)) continue;
    strings.push(resolve(value));
    try { strings.push(await canonical(value)); }
    catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
    }
  }
  return candidate => {
    if (paths.some(path => withinPackage(path, candidate.path)))
      return 'PACKAGE_INSTALLATION_OR_RECOVERY_REFERENCE';
    if (strings.some(value => withinPackage(value, candidate.path)))
      return 'PACKAGE_ADOPTED_OR_RECOVERY_REFERENCE';
    // Unfinished replacement may have to execute the source recorded in binding.
    if (retirement && (retirement.phase !== 'retired' ||
      retirement.replacement?.phase !== 'released')) {
      const commit = JSON.parse(candidate.manifest).commit;
      if (strings.includes(commit)) return 'PACKAGE_REPLACEMENT_RECOVERY_REFERENCE';
    }
    return null;
  };
}

export const installedPackageParent = context => {
  requireThat(context.host.installation.directory === '/opt/nibfin/core',
    'INVALID_HOST_ADOPTION');
  return join(dirname(context.host.installation.directory));
};
