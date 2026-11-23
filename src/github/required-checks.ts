import type { GitHubClient } from "./client.ts";
import { read, readOptional } from "./errors.ts";
import { isNibfinWorkflow } from "./nibfin-workflows.ts";
import type { Repo } from "./repo.ts";
import { commitStatusState, type RunState, runState } from "./run-state.ts";

/** A check the base branch requires; `integrationId: null` accepts any source. */
export interface RequiredCheck {
  context: string;
  integrationId: number | null;
}

export interface RequiredCheckResult extends RequiredCheck {
  state: RunState;
  /** What gave the result; `none` when nothing reported it yet. */
  source: "check-run" | "status" | "none";
  /** The check run's or status's `html_url` / `target_url`, when it has one. */
  url: string | null;
  /** Only for `check-run`: its id, which for GitHub Actions is the job id. */
  checkRunId?: number;
  /** Only for `check-run`: the slug of the app that created it, if GitHub names one. */
  appSlug?: string | null;
}

/** The CI of a pull request head: the base branch's required checks and their results. */
export interface CiState {
  requiredChecks: RequiredCheck[];
  results: RequiredCheckResult[];
}

const perPage = 100;

/**
 * Required checks of `branch` from its rulesets and from classic branch protection, as
 * the branch endpoint shows it (the protection endpoint needs Administration). A
 * missing branch has no classic protection.
 */
export async function readRequiredChecks(
  client: GitHubClient,
  repo: Repo,
  branch: string,
): Promise<RequiredCheck[]> {
  const where = `${repo.owner}/${repo.repo}@${branch}`;
  const rules = await read(`read rules of ${where}`, () =>
    client.paginate("GET /repos/{owner}/{repo}/rules/branches/{branch}", {
      ...repo,
      branch,
      per_page: perPage,
    }),
  );
  const fromRules = rules.flatMap((rule) =>
    rule.type === "required_status_checks"
      ? (rule.parameters?.required_status_checks ?? []).map((check) => ({
          context: check.context,
          integrationId: check.integration_id ?? null,
        }))
      : [],
  );
  const branchData = await readOptional(`read branch ${where}`, () =>
    client.request("GET /repos/{owner}/{repo}/branches/{branch}", { ...repo, branch }),
  );
  const classic = branchData?.data.protection?.required_status_checks;
  const fromChecks = (classic?.checks ?? []).map((check) => ({
    context: check.context,
    integrationId: check.app_id === null || check.app_id === -1 ? null : check.app_id,
  }));
  const fromContexts = (classic?.contexts ?? [])
    .filter((context) => !fromChecks.some((check) => check.context === context))
    .map((context) => ({ context, integrationId: null }));
  return unique([...fromRules, ...fromChecks, ...fromContexts]);
}

function unique(checks: RequiredCheck[]): RequiredCheck[] {
  const seen = new Map<string, RequiredCheck>();
  for (const check of checks) {
    seen.set(`${check.context}\u0000${check.integrationId}`, check);
  }
  return [...seen.values()];
}

interface CheckRunResult {
  id: number;
  name: string;
  appId: number | null;
  appSlug: string | null;
  state: RunState;
  url: string | null;
}

interface StatusResult {
  state: RunState;
  url: string | null;
}

/**
 * Results of `required` on commit `sha`: the newest matching check run (by context and
 * app), else for an any-source check the newest commit status of that context. A
 * commit status carries no app id, so it satisfies only any-source checks. Check runs of
 * Nibfin's own workflows never count.
 */
export async function readRequiredCheckResults(
  client: GitHubClient,
  repo: Repo,
  required: readonly RequiredCheck[],
  sha: string,
): Promise<RequiredCheckResult[]> {
  if (required.length === 0) {
    return [];
  }
  const checkRuns = await readCheckRuns(client, repo, sha);
  const statuses = await readStatuses(client, repo, sha);
  return required.map((check) => {
    const run = checkRuns
      .filter((candidate) => candidate.name === check.context)
      .filter((candidate) => matchesSource(check, candidate.appId))
      .reduce<CheckRunResult | undefined>(
        (newest, candidate) => (newest && newest.id > candidate.id ? newest : candidate),
        undefined,
      );
    if (run) {
      return {
        ...check,
        state: run.state,
        source: "check-run",
        url: run.url,
        checkRunId: run.id,
        appSlug: run.appSlug,
      };
    }
    const status = check.integrationId === null ? statuses.get(check.context) : undefined;
    if (status) {
      return { ...check, state: status.state, source: "status", url: status.url };
    }
    return { ...check, state: "pending", source: "none", url: null };
  });
}

function matchesSource(check: RequiredCheck, appId: number | null): boolean {
  return check.integrationId === null || check.integrationId === appId;
}

async function readCheckRuns(
  client: GitHubClient,
  repo: Repo,
  sha: string,
): Promise<CheckRunResult[]> {
  const where = `${repo.owner}/${repo.repo}@${sha}`;
  const runs = await read(`read check runs of ${where}`, () =>
    client.paginate("GET /repos/{owner}/{repo}/commits/{ref}/check-runs", {
      ...repo,
      ref: sha,
      per_page: perPage,
    }),
  );
  const nibfinSuites = await readNibfinCheckSuites(client, repo, sha);
  return runs
    .filter((run) => !(run.check_suite && nibfinSuites.has(run.check_suite.id)))
    .map((run) => ({
      id: run.id,
      name: run.name,
      appId: run.app?.id ?? null,
      appSlug: run.app?.slug ?? null,
      state: runState(run.status, run.conclusion),
      url: run.html_url,
    }));
}

/** Check suites of Nibfin's own workflow runs on `sha`. */
async function readNibfinCheckSuites(
  client: GitHubClient,
  repo: Repo,
  sha: string,
): Promise<Set<number>> {
  const where = `${repo.owner}/${repo.repo}@${sha}`;
  const runs = await read(`read workflow runs of ${where}`, () =>
    client.paginate("GET /repos/{owner}/{repo}/actions/runs", {
      ...repo,
      head_sha: sha,
      per_page: perPage,
    }),
  );
  return new Set(
    runs
      .filter((run) => isNibfinWorkflow(run.name))
      .flatMap((run) => (run.check_suite_id === undefined ? [] : [run.check_suite_id])),
  );
}

/** The newest commit status per context. */
async function readStatuses(
  client: GitHubClient,
  repo: Repo,
  sha: string,
): Promise<Map<string, StatusResult>> {
  const where = `${repo.owner}/${repo.repo}@${sha}`;
  const statuses = await read(`read statuses of ${where}`, () =>
    client.paginate("GET /repos/{owner}/{repo}/commits/{ref}/statuses", {
      ...repo,
      ref: sha,
      per_page: perPage,
    }),
  );
  const newest = new Map<string, (typeof statuses)[number]>();
  for (const status of statuses) {
    const current = newest.get(status.context);
    if (!current || status.id > current.id) {
      newest.set(status.context, status);
    }
  }
  return new Map(
    [...newest].map(([context, status]) => [
      context,
      { state: commitStatusState(status.state), url: status.target_url },
    ]),
  );
}

/** The CI of a pull request: required checks of `baseRef` and their results on `sha`. */
export async function readCi(
  client: GitHubClient,
  repo: Repo,
  baseRef: string,
  sha: string,
): Promise<CiState> {
  const requiredChecks = await readRequiredChecks(client, repo, baseRef);
  const results = await readRequiredCheckResults(client, repo, requiredChecks, sha);
  return { requiredChecks, results };
}
