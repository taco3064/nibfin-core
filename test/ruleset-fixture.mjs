import observation from './native-protection-observation.json' with { type: 'json' };
import { digest } from '../src/identity.mjs';

// Parameterized native response shape for unit contracts, never an authority grant.
export function rulesetFixture(policy, repository = 'example/core') {
  const value = structuredClone(observation.ruleset);
  value.source = repository;
  const review = value.rules.find((rule) => rule.type === 'pull_request').parameters;
  const expected = policy.required_pull_request_reviews;
  Object.assign(review, {
    required_approving_review_count: expected.required_approving_review_count,
    dismiss_stale_reviews_on_push: expected.dismiss_stale_reviews,
    require_code_owner_review: expected.require_code_owner_reviews,
    require_last_push_approval: expected.require_last_push_approval,
    required_review_thread_resolution:
      policy.required_conversation_resolution?.enabled === true,
  });
  const rules = value.rules.map((rule) => ({
    type: rule.type,
    ruleset_id: value.id,
    ruleset_source_type: 'Repository',
    ruleset_source: repository,
    parameters: rule.parameters ?? null,
  }));
  return {
    value,
    rules,
    pin: { id: value.id, hash: digest(value) },
    hash: digest({ policy, rules, ruleset: value }),
  };
}
