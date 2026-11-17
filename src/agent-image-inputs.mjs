import { requireThat } from './identity.mjs';
import { linuxArchitecture } from './linux-architecture.mjs';

const immutable = /^sha256:[a-f0-9]{64}$/;
const indexTypes = new Set([
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
]);
const imageTypes = new Set([
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
]);

// The public Agent recipe owns the pinned source facts. Managed preparation
// resolves its immutable indexes, never tags or repository-supplied inputs.
export function agentSources(recipe) {
  const sources = {};
  for (const [name, image, suffix] of [
    ['go', 'golang', ' AS go'], ['node', 'node', ''],
  ]) {
    const pattern = new RegExp(`^FROM (${image}@sha256:[a-f0-9]{64})${suffix}$`, 'm');
    const match = pattern.exec(recipe);
    requireThat(match, 'RESOURCE_INPUT_CONTRACT_INVALID');
    sources[name] = `docker.io/library/${match[1]}`;
  }
  return sources;
}

export function nativeManifest(index, architecture) {
  const arch = linuxArchitecture('linux', architecture);
  requireThat(arch, 'RESOURCE_INPUT_PLATFORM_UNSUPPORTED');
  requireThat(index?.schemaVersion === 2 && indexTypes.has(index.mediaType) &&
    Array.isArray(index.manifests), 'RESOURCE_INPUT_INDEX_INVALID');
  const records = {};
  for (const target of ['amd64', 'arm64']) {
    const matches = index.manifests.filter(record =>
      record?.platform?.os === 'linux' && record.platform.architecture === target &&
      (!record.platform.variant ||
        (target === 'arm64' && record.platform.variant === 'v8')));
    requireThat(matches.length === 1, 'RESOURCE_INPUT_MANIFEST_UNAVAILABLE');
    const record = matches[0];
    requireThat(immutable.test(record.digest) && imageTypes.has(record.mediaType) &&
      Number.isSafeInteger(record.size) && record.size > 0,
    'RESOURCE_INPUT_MANIFEST_INVALID');
    records[target] = record.digest;
  }
  return records[arch];
}

export async function resolveAgentInputs(recipe, architecture, inspect) {
  const arch = linuxArchitecture('linux', architecture);
  requireThat(arch, 'RESOURCE_INPUT_PLATFORM_UNSUPPORTED');
  const sources = agentSources(recipe);
  const resolved = { platform: `linux/${arch}`, sources, images: {} };
  for (const [name, source] of Object.entries(sources)) {
    let index;
    try { index = JSON.parse(await inspect(source)); }
    catch { requireThat(false, 'RESOURCE_INPUT_INDEX_UNAVAILABLE'); }
    const manifest = nativeManifest(index, arch);
    resolved.images[name] = `${source.split('@')[0]}@${manifest}`;
  }
  return resolved;
}

export function resolvedAgentRecipe(recipe, resolved) {
  requireThat(resolved && /^linux\/(amd64|arm64)$/.test(resolved.platform),
    'RESOURCE_INPUT_CONTRACT_INVALID');
  for (const name of ['go', 'node']) {
    const token = `nibfin-reviewed-${name}-input`;
    const image = resolved.images[name];
    const source = resolved.sources[name];
    requireThat(typeof source === 'string' && typeof image === 'string' &&
      image.split('@')[0] === source.split('@')[0] &&
      immutable.test(image.split('@')[1]) &&
      recipe.split(token).length === 2, 'RESOURCE_INPUT_CONTRACT_INVALID');
    recipe = recipe.replace(token, image);
  }
  return recipe;
}

// Acquisition is credential-free and cannot authorize an image of another
// platform. Pulling immutable inputs does not replace any managed resource.
export async function prepareAgentInputs(recipe, architecture, docker) {
  const resolved = await resolveAgentInputs(recipe, architecture,
    source => docker(['manifest', 'inspect', source]));
  for (const image of Object.values(resolved.images)) {
    try {
      await docker(['pull', '--platform', resolved.platform, image], {
        timeout: 20 * 60 * 1000, limit: 4 * 1024 * 1024,
      });
    } catch { requireThat(false, 'RESOURCE_INPUT_IMAGE_UNAVAILABLE'); }
    let rows;
    try { rows = JSON.parse(await docker(['image', 'inspect', image])); }
    catch { requireThat(false, 'RESOURCE_INPUT_IMAGE_UNAVAILABLE'); }
    requireThat(Array.isArray(rows) && rows.length === 1 &&
      linuxArchitecture(rows[0].Os, rows[0].Architecture) ===
        resolved.platform.slice(6), 'RESOURCE_INPUT_IMAGE_PLATFORM_MISMATCH');
  }
  return resolved;
}

export function agentVersions(recipe, projectPackage, managedPackage) {
  const node = projectPackage.engines?.node;
  const codex = /^ARG CODEX_VERSION=(\S+)$/m.exec(recipe)?.[1];
  const go = /GOVERSION\)" = go(\d+\.\d+\.\d+)/.exec(recipe)?.[1];
  const npm = managedPackage.dependencies?.npm;
  requireThat([node, codex, go, npm].every(version =>
    typeof version === 'string' && /^\d+\.\d+\.\d+$/.test(version)) &&
    codex === managedPackage.dependencies?.['@openai/codex'],
  'RESOURCE_INPUT_CONTRACT_INVALID');
  return { node, codex: `codex-cli ${codex}`, go, npm };
}
