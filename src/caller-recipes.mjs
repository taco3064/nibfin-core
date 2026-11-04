import templates from './caller-recipes.json' with { type: 'json' };
import { isSha, requireThat } from './identity.mjs';

// Public codeless caller templates are shared with thin installers. Exact byte
// matching is deliberately narrower than accepting arbitrary equivalent YAML.
export function callerRecipe(kind, commit) {
  requireThat(Object.hasOwn(templates, kind) && isSha(commit), 'INVALID_CALLER_RECIPE');
  return templates[kind].join('\n').replaceAll('CORE_COMMIT', commit);
}
