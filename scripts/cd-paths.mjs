import { includesPackagePath } from '../src/source-package.mjs';

export const cdWorkflow = '.github/workflows/cd.yml';

export function websiteInput(path) {
  return path.startsWith('website/') || path === cdWorkflow ||
    /^(?:package(?:-lock)?\.json|\.node-version|\.npmrc)$/.test(path);
}

export function cdPaths(paths, subject = '') {
  const pinUpdate = /^Prepare Core [a-f0-9]{40} rollout$/.test(subject) &&
    paths.every(path => path === '.nibfin/producer-pins.json' ||
      /^\.github\/workflows\/nibfin-(issue|wake)\.yml$/.test(path));
  return {
    core: !pinUpdate &&
      paths.some(path => includesPackagePath(path) || path === 'scripts/cd-drafts.sh'),
    website: paths.some(websiteInput),
  };
}
