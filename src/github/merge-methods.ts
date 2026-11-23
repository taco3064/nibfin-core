import type { GitHubClient } from "./client.ts";
import { read } from "./errors.ts";
import type { Repo } from "./repo.ts";

/** A merge method of `PUT …/pulls/{n}/merge`. */
export type MergeMethod = "rebase" | "squash" | "merge";

/** Nibfin's preference: the first allowed one is used. */
export const mergeMethodOrder: readonly MergeMethod[] = ["rebase", "squash", "merge"];

/** The repository's merge settings; `undefined` when GitHub did not return one. */
export interface MergeSettings {
  rebase: boolean | undefined;
  squash: boolean | undefined;
  merge: boolean | undefined;
}

/** The parameters of one ruleset `pull_request` rule that apply to a branch. */
export interface PullRequestRule {
  requiredApprovals: number;
  codeOwnerReview: boolean;
  lastPushApproval: boolean;
  threadResolution: boolean;
  /** `undefined` when the rule does not restrict merge methods. */
  allowedMethods: MergeMethod[] | undefined;
}

/** What the base branch's rulesets say about merging into it. */
export interface MergeRules {
  pullRequest: PullRequestRule[];
  /** A `required_linear_history` rule applies: no merge commits. */
  linearHistory: boolean;
}

/** `allow_rebase_merge`, `allow_squash_merge` and `allow_merge_commit` of `repo`. */
export async function readMergeSettings(
  client: GitHubClient,
  repo: Repo,
): Promise<MergeSettings> {
  const { data } = await read(`read ${repo.owner}/${repo.repo}`, () =>
    client.request("GET /repos/{owner}/{repo}", { ...repo }),
  );
  return {
    rebase: data.allow_rebase_merge,
    squash: data.allow_squash_merge,
    merge: data.allow_merge_commit,
  };
}

/** The `pull_request` and `required_linear_history` rules that apply to `branch`. */
export async function readMergeRules(
  client: GitHubClient,
  repo: Repo,
  branch: string,
): Promise<MergeRules> {
  const where = `${repo.owner}/${repo.repo}@${branch}`;
  const rules = await read(`read rules of ${where}`, () =>
    client.paginate("GET /repos/{owner}/{repo}/rules/branches/{branch}", {
      ...repo,
      branch,
      per_page: 100,
    }),
  );
  const pullRequest = rules.flatMap((rule) =>
    rule.type === "pull_request"
      ? [
          {
            requiredApprovals: rule.parameters?.required_approving_review_count ?? 0,
            codeOwnerReview: rule.parameters?.require_code_owner_review ?? false,
            lastPushApproval: rule.parameters?.require_last_push_approval ?? false,
            threadResolution: rule.parameters?.required_review_thread_resolution ?? false,
            allowedMethods: rule.parameters?.allowed_merge_methods,
          },
        ]
      : [],
  );
  const linearHistory = rules.some((rule) => rule.type === "required_linear_history");
  return { pullRequest, linearHistory };
}

/**
 * The methods both the repository settings and every applying rule allow, in
 * Nibfin's order. `undefined` when a setting is unknown, so nothing can be chosen
 * safely.
 */
export function allowedMergeMethods(
  settings: MergeSettings,
  rules: MergeRules,
): MergeMethod[] | undefined {
  if (Object.values(settings).some((value) => value === undefined)) {
    return undefined;
  }
  return mergeMethodOrder.filter(
    (method) =>
      settings[method] === true &&
      !(rules.linearHistory && method === "merge") &&
      rules.pullRequest.every(
        (rule) =>
          rule.allowedMethods === undefined || rule.allowedMethods.includes(method),
      ),
  );
}
