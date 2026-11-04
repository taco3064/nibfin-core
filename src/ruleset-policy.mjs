import { digest, isId, isDigest, requireThat } from './identity.mjs';

export const adoptedRuleTypes = Object.freeze([
  'pull_request',
  'required_status_checks',
  'non_fast_forward',
  'deletion',
]);

const same = (left, right) => digest(left) === digest(right);
const checks = (values, key) =>
  values
    .map((value) => ({
      context: value.context,
      app: value[key],
    }))
    .sort((a, b) => a.context.localeCompare(b.context));

export function validateRulesetPin(pin) {
  requireThat(
    isId(pin?.id) &&
      isDigest(pin.hash) &&
      Object.keys(pin).every((key) => ['id', 'hash'].includes(key)),
    'RULESET_NOT_ADOPTED',
  );
  return pin;
}

// One finite configuration observed on the actual public test repository.
// This is not a ruleset evaluator: unknown rules and different policies deny.
export function validateAdoptedRuleset(value, pin, policy, repository, branch) {
  validateRulesetPin(pin);
  requireThat(
    value?.id === pin.id &&
      digest(value) === pin.hash &&
      value.source_type === 'Repository' &&
      value.source === repository &&
      value.target === 'branch' &&
      value.enforcement === 'active' &&
      Array.isArray(value.bypass_actors) &&
      value.bypass_actors.length === 0 &&
      same(value.conditions, {
        ref_name: { include: [`refs/heads/${branch}`], exclude: [] },
      }),
    'RULESET_NOT_ADOPTED',
  );
  requireThat(
    Array.isArray(value.rules) &&
      value.rules.length === adoptedRuleTypes.length &&
      new Set(value.rules.map((rule) => rule.type)).size === value.rules.length &&
      value.rules.every(
        (rule) =>
          adoptedRuleTypes.includes(rule.type) &&
          Object.keys(rule).every((key) => ['type', 'parameters'].includes(key)),
      ),
    'UNSUPPORTED_RULESET_POLICY',
  );
  const rules = Object.fromEntries(value.rules.map((rule) => [rule.type, rule]));
  const review = rules.pull_request.parameters;
  const expected = policy.required_pull_request_reviews;
  const reviewKeys = [
    'allowed_merge_methods',
    'dismiss_stale_reviews_on_push',
    'required_reviewers',
    'require_code_owner_review',
    'require_last_push_approval',
    'required_approving_review_count',
    'required_review_thread_resolution',
    'require_extra_approval_for_unattributed_changes',
  ];
  requireThat(
    review &&
      Object.keys(review).every((key) => reviewKeys.includes(key)) &&
      Array.isArray(review.allowed_merge_methods) &&
      same(review.allowed_merge_methods?.toSorted(), ['merge', 'rebase', 'squash']) &&
      review.required_approving_review_count ===
        expected.required_approving_review_count &&
      review.dismiss_stale_reviews_on_push === expected.dismiss_stale_reviews &&
      review.require_code_owner_review === expected.require_code_owner_reviews &&
      review.require_last_push_approval === expected.require_last_push_approval &&
      review.required_review_thread_resolution ===
        (policy.required_conversation_resolution?.enabled === true) &&
      review.require_extra_approval_for_unattributed_changes === true &&
      Array.isArray(review.required_reviewers) &&
      review.required_reviewers.length === 0,
    'RULESET_REVIEW_POLICY_CHANGED',
  );
  const required = rules.required_status_checks.parameters;
  requireThat(
    required &&
      Object.keys(required).every((key) =>
        [
          'strict_required_status_checks_policy',
          'do_not_enforce_on_create',
          'required_status_checks',
        ].includes(key),
      ) &&
      required.strict_required_status_checks_policy === true &&
      required.do_not_enforce_on_create === false &&
      Array.isArray(required.required_status_checks) &&
      required.required_status_checks.every(
        (check) =>
          isId(check?.integration_id) &&
          typeof check.context === 'string' &&
          Object.keys(check).every((key) => ['context', 'integration_id'].includes(key)),
      ) &&
      same(
        checks(required.required_status_checks, 'integration_id'),
        checks(policy.required_status_checks.checks, 'app_id'),
      ),
    'RULESET_CHECK_POLICY_CHANGED',
  );
  for (const type of ['deletion', 'non_fast_forward']) {
    requireThat(!rules[type].parameters, 'UNSUPPORTED_RULESET_POLICY');
  }
  return rules;
}

export function validateEffectiveRules(values, ruleset, repository) {
  const rules = Object.fromEntries(ruleset.rules.map((rule) => [rule.type, rule]));
  requireThat(
    Array.isArray(values) &&
      values.length === ruleset.rules.length &&
      new Set(values.map((rule) => rule.type)).size === values.length &&
      values.every(
        (rule) =>
          rule.ruleset_id === ruleset.id &&
          Object.keys(rule).every((key) =>
            [
              'type',
              'ruleset_id',
              'ruleset_source_type',
              'ruleset_source',
              'parameters',
            ].includes(key),
          ) &&
          rule.ruleset_source_type === 'Repository' &&
          rule.ruleset_source === repository &&
          Object.hasOwn(rules, rule.type) &&
          same(rule.parameters ?? null, rules[rule.type].parameters ?? null),
      ),
    'UNSUPPORTED_EFFECTIVE_RULES',
  );
}
