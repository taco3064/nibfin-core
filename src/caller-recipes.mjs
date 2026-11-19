import templates from './caller-recipes.json' with { type: 'json' };
import { isSha, isId, requireThat } from './identity.mjs';

// Public codeless caller templates are shared with thin installers. Exact byte
// matching is deliberately narrower than accepting arbitrary equivalent YAML.
export function callerRecipe(kind, commit, action = {}) {
  requireThat(Object.hasOwn(templates, kind) && isSha(commit), 'INVALID_CALLER_RECIPE');
  if (kind === 'action-wake' || kind === 'action-dispatch') {
    requireThat(
      isSha(action.actionCommit) && isId(action.memberId),
      'INVALID_ACTION_CALLER_RECIPE',
    );
  }
  return templates[kind]
    .join('\n')
    .replaceAll('CORE_COMMIT', commit)
    .replaceAll('ACTION_COMMIT', action.actionCommit ?? '')
    .replaceAll('MEMBER_ID', String(action.memberId ?? ''));
}

// Derive historical bytes only from the maintained workflow-level title block.
// Never remove title-like content from untrusted caller input.
export function callerRecipeVariants(kind, commit, action = {}) {
  const titled = callerRecipe(kind, commit, action);
  const lines = titled.split('\n');
  const start = lines.indexOf('run-name: >-');
  requireThat(start >= 0, 'INVALID_CALLER_RECIPE');
  let end = start + 1;
  while (lines[end]?.startsWith('  ')) end++;
  return [titled, [...lines.slice(0, start), ...lines.slice(end)].join('\n')];
}

export function wakeRecipe(coreCommit, workflow, memberId) {
  const recipe = {
    kind: workflow.actionCommit === undefined ? 'wake' : 'action-wake',
    coreCommit,
    ...(workflow.actionCommit === undefined
      ? {}
      : {
          actionCommit: workflow.actionCommit,
          memberId,
        }),
  };
  callerRecipe(recipe.kind, coreCommit, recipe);
  return recipe;
}
