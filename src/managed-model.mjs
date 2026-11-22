// The managed default per provider is validated against the authenticated
// provider at adoption. Codex keeps its original export.
export const managedModels = Object.freeze({
  codex: 'gpt-6.1', claude: 'claude-opus-5-5',
});
export const managedModel = managedModels.codex;
