import { requireThat } from './identity.mjs';
import { adoptedRuleTypes } from './ruleset-policy.mjs';

// A suite is actual historical enforcement, never inferred from today's policy.
// GitHub omits evaluation_result when no evaluate-mode result is present.
export function verifyMergeEnforcement(suite, pin, actorId, branch, protection) {
  const evaluations = suite?.rule_evaluations;
  const ruleset = protection.ruleset;
  const validSource = (source) =>
    source?.type === 'protected_branch' ||
    (ruleset && source?.type === 'ruleset' && source.id === ruleset.id);
  requireThat(
    suite?.id === pin.ruleSuiteId &&
      suite.repository_id === pin.repositoryId &&
      suite.before_sha === pin.base &&
      suite.after_sha === pin.merge &&
      suite.ref === `refs/heads/${branch}` &&
      suite.actor_id === actorId &&
      suite.result === 'pass' &&
      (!Object.hasOwn(suite, 'evaluation_result') ||
        suite.evaluation_result === 'pass') &&
      Array.isArray(evaluations) &&
      evaluations.length > 0 &&
      evaluations.every(
        (rule) =>
          rule.enforcement === 'active' &&
          rule.result === 'pass' &&
          validSource(rule.rule_source),
      ),
    'MISSING_OR_BYPASSED_MERGE_ENFORCEMENT',
  );
  const requireTypes = (type, id, expected) => {
    const selected = evaluations.filter(
      (rule) =>
        rule.rule_source.type === type &&
        (id === undefined || rule.rule_source.id === id),
    );
    requireThat(
      expected.every(
        (name) => selected.filter((rule) => rule.rule_type === name).length === 1,
      ),
      'MISSING_OR_BYPASSED_MERGE_ENFORCEMENT',
    );
    if (type === 'ruleset')
      requireThat(
        selected.length === expected.length,
        'MISSING_OR_BYPASSED_MERGE_ENFORCEMENT',
      );
  };
  const classic = ruleset
    ? [...adoptedRuleTypes]
    : ['pull_request', 'required_status_checks'];
  if (ruleset && protection.policy.required_conversation_resolution?.enabled === true)
    classic.push('required_review_thread_resolution');
  requireTypes('protected_branch', undefined, classic);
  if (ruleset) requireTypes('ruleset', ruleset.id, adoptedRuleTypes);
}
