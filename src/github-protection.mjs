import { repoPath } from './github-read.mjs';
import { digest, requireThat, isId } from './identity.mjs';
import {
  validateAdoptedRuleset,
  validateEffectiveRules,
  validateRulesetPin,
} from './ruleset-policy.mjs';

export function checkProtection(policy) {
  const reviews = policy?.required_pull_request_reviews;
  const checks = policy?.required_status_checks;
  requireThat(
    policy?.enforce_admins?.enabled === true &&
      policy.allow_force_pushes?.enabled === false &&
      policy.allow_deletions?.enabled === false,
    'UNENFORCED_PROTECTION',
  );
  requireThat(
    reviews?.require_code_owner_reviews === false,
    'CODEOWNERS_ADAPTER_REQUIRED',
  );
  const count = reviews?.required_approving_review_count;
  requireThat(
    Number.isSafeInteger(count) &&
      count >= 0 &&
      count <= 6 &&
      (count === 0
        ? reviews.require_last_push_approval === false
        : reviews.dismiss_stale_reviews === true &&
          reviews.require_last_push_approval === true),
    'INSUFFICIENT_REVIEW_PROTECTION',
  );
  const bypass = reviews.bypass_pull_request_allowances;
  requireThat(
    bypass === undefined ||
      (['users', 'teams', 'apps'].every(
        (key) => Array.isArray(bypass[key]) && bypass[key].length === 0,
      ) &&
        Object.keys(bypass).every((key) => ['users', 'teams', 'apps'].includes(key))),
    'BYPASS_ALLOWED',
  );
  requireThat(
    checks?.strict === true &&
      Array.isArray(checks.checks) &&
      checks.checks.length > 0 &&
      checks.checks.every(
        (check) =>
          typeof check.context === 'string' && check.context.trim() && isId(check.app_id),
      ) &&
      new Set(checks.checks.map((check) => check.context)).size === checks.checks.length,
    'UNBOUND_REQUIRED_CHECKS',
  );
  requireThat(
    Array.isArray(checks.contexts) &&
      checks.contexts.length === checks.checks.length &&
      checks.contexts.every((context) =>
        checks.checks.some((check) => check.context === context),
      ) &&
      new Set(checks.contexts).size === checks.contexts.length,
    'UNBOUND_REQUIRED_CHECKS',
  );
  return policy;
}

// Optional ruleset adoption is installed outside the Agent/Candidate boundary.
// Legacy pure-classic pins keep their original protection hash and refusals.
export async function readProtection(reader, repository, branch, adoption) {
  const root = repoPath(repository),
    encoded = encodeURIComponent(branch);
  const policy = checkProtection(
    await reader.get(root + '/branches/' + encoded + '/protection'),
  );
  const rules = await reader.list(root + '/rules/branches/' + encoded);
  if (adoption === undefined) {
    requireThat(rules.length === 0, 'UNSUPPORTED_EFFECTIVE_RULES');
    return { policy, rules, hash: digest(policy) };
  }
  validateRulesetPin(adoption);
  const ruleset = await reader.get(root + '/rulesets/' + adoption.id);
  validateAdoptedRuleset(ruleset, adoption, policy, repository, branch);
  validateEffectiveRules(rules, ruleset, repository);
  return { policy, rules, ruleset, hash: digest({ policy, rules, ruleset }) };
}
