import { requireThat } from './identity.mjs';

const tag = kind => `nibfin-managed-resource:${kind}`;
export const platformTag = (kind, arch) => arch === 'amd64'
  ? tag(kind) : `${tag(kind)}-${arch}`;
export const derivedBaseInput = 'nibfin-managed-agent-input';

async function inspectOne(docker, reference) {
  let rows;
  try {
    rows = JSON.parse(await docker(['image', 'inspect', reference]));
  } catch { requireThat(false, 'RESOURCE_IMAGE_CONFLICT'); }
  requireThat(Array.isArray(rows) && rows.length === 1, 'RESOURCE_IMAGE_CONFLICT');
  return rows[0];
}

// BuildKit resolves `FROM sha256:<id>` as a registry name, so derived recipes
// build FROM the managed Agent tag after proving it still names the prepared ID.
export async function derivedRecipe(recipe, agentId, arch, docker) {
  const base = platformTag('agent', arch);
  requireThat((await inspectOne(docker, base)).Id === agentId,
    'RESOURCE_IMAGE_CONFLICT');
  return recipe.replace(derivedBaseInput, base);
}

// A derived image must sit on the prepared Agent image's filesystem layers.
export async function requireDerivedLayers(row, agentId, docker) {
  const base = (await inspectOne(docker, agentId)).RootFS?.Layers;
  const layers = row.RootFS?.Layers;
  requireThat(Array.isArray(base) && base.length > 0 && Array.isArray(layers) &&
    base.every((layer, index) => layers[index] === layer),
  'RESOURCE_IMAGE_CONFLICT');
}
