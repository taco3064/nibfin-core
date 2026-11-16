import { posix } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { includesPackagePath } from '../src/source-package.mjs';

export const cdWorkflow = '.github/workflows/cd.yml';

export function docsNeedRetry(jobs) {
  if (!Array.isArray(jobs)) return true;
  const build = jobs.find(job => job.name === 'build-docs');
  if (!build || build.conclusion === 'skipped') return false;
  const deploy = jobs.find(job => job.name === 'deploy-docs');
  return !deploy?.steps?.some(step => step.conclusion === 'success' &&
    (step.name === 'Publish Docs to Pages' ||
      step.name?.startsWith('Run actions/deploy-pages@')));
}

export function websiteInput(path) {
  return path.startsWith('website/') || path === cdWorkflow ||
    /^(?:package(?:-lock)?\.json|\.node-version|\.npmrc)$/.test(path);
}

function coreLockEntries(lock) {
  const { packages, ...metadata } = lock;
  if (metadata.lockfileVersion !== 3 || !packages?.['']) {
    throw new Error('Unsupported npm lockfile');
  }
  // Walk the root's dependencies without following the implicit website workspace.
  const reachable = {};
  function visit(location) {
    if (Object.hasOwn(reachable, location)) return;
    const entry = packages[location];
    if (!entry || entry.link) throw new Error('Unsupported linked or missing package');
    reachable[location] = entry;
    const dependencies = {
      ...entry.dependencies, ...entry.optionalDependencies, ...entry.peerDependencies,
      ...(location === '' ? entry.devDependencies : {}),
    };
    for (const name of Object.keys(dependencies)) {
      let parent = location;
      while (true) {
        const candidate = posix.join(parent, 'node_modules', name);
        const validParent = posix.basename(parent) !== 'node_modules';
        if (validParent && Object.hasOwn(packages, candidate)) {
          visit(candidate);
          break;
        }
        if (!parent) {
          if (!Object.hasOwn(entry.optionalDependencies ?? {}, name) &&
              !entry.peerDependenciesMeta?.[name]?.optional) {
            throw new Error(`Missing locked dependency ${name}`);
          }
          break;
        }
        parent = posix.dirname(parent);
        if (parent === '.') parent = '';
      }
    }
  }
  visit('');
  return { metadata, reachable };
}

export function websiteOnlyLockChange(before, after) {
  try {
    const previous = coreLockEntries(JSON.parse(before));
    const next = coreLockEntries(JSON.parse(after));
    return isDeepStrictEqual(previous, next);
  } catch {
    return false;
  }
}

export function cdPaths(paths, subject = '', websiteLockOnly = false) {
  const pinUpdate = /^Prepare Core [a-f0-9]{40} rollout$/.test(subject) &&
    paths.every(path => path === '.nibfin/producer-pins.json' ||
      /^\.github\/workflows\/nibfin-(issue|wake)\.yml$/.test(path));
  return {
    core: !pinUpdate &&
      paths.some(path => (path !== 'package-lock.json' || !websiteLockOnly) &&
        (includesPackagePath(path) || path === 'scripts/cd-drafts.sh')),
    website: paths.some(websiteInput),
  };
}
