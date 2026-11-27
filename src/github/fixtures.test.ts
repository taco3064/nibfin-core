/** Test support: GitHub REST objects with the fields Nibfin reads. */

export interface PullOptions {
  state?: "open" | "closed";
  merged?: boolean;
  head?: string;
  base?: string;
  sha?: string;
  mergeSha?: string | null;
}

export function pull(number: number, options: PullOptions = {}) {
  const merged = options.merged ?? false;
  return {
    number,
    state: options.state ?? (merged ? "closed" : "open"),
    merged_at: merged ? "2026-11-23T00:00:00Z" : null,
    head: { ref: options.head ?? "nibfin/issue-1", sha: options.sha ?? `head-${number}` },
    base: { ref: options.base ?? "main" },
    merge_commit_sha:
      options.mergeSha === undefined
        ? merged
          ? `merge-${number}`
          : null
        : options.mergeSha,
    html_url: `https://github.com/acme/app/pull/${number}`,
  };
}

export interface IssueOptions {
  state?: "open" | "closed";
  stateReason?: string | null;
  labels?: Array<string | { name?: string }>;
  assignees?: Array<{ id: number; login: string }>;
  totalBlockedBy?: number;
  totalBlocking?: number;
  pullRequest?: boolean;
  owner?: string;
  repo?: string;
}

export function issue(number: number, options: IssueOptions = {}) {
  const owner = options.owner ?? "acme";
  const repo = options.repo ?? "app";
  return {
    number,
    state: options.state ?? "open",
    state_reason: options.stateReason,
    labels: (options.labels ?? []).map((label) =>
      typeof label === "string" ? { name: label } : label,
    ),
    assignees: options.assignees,
    repository_url: `https://api.github.com/repos/${owner}/${repo}`,
    html_url: `https://github.com/${owner}/${repo}/issues/${number}`,
    ...(options.pullRequest ? { pull_request: { url: "x" } } : {}),
    ...(options.totalBlockedBy === undefined && options.totalBlocking === undefined
      ? {}
      : {
          issue_dependencies_summary: {
            blocked_by: 0,
            blocking: 0,
            total_blocked_by: options.totalBlockedBy ?? 0,
            total_blocking: options.totalBlocking ?? 0,
          },
        }),
  };
}

export interface CheckRunOptions {
  status?: string;
  conclusion?: string | null;
  appId?: number | null;
  suiteId?: number | null;
  /** The app's slug; `undefined` leaves it out of the app object. */
  slug?: string;
}

export function checkRun(id: number, name: string, options: CheckRunOptions = {}) {
  const slug = options.slug === undefined ? {} : { slug: options.slug };
  return {
    id,
    name,
    status: options.status ?? "completed",
    conclusion: options.conclusion === undefined ? "success" : options.conclusion,
    app: options.appId === null ? null : { id: options.appId ?? 15368, ...slug },
    check_suite: options.suiteId === null ? null : { id: options.suiteId ?? 7000 + id },
    html_url: `https://github.com/acme/app/runs/${id}`,
  };
}

export function commitStatus(id: number, context: string, state: string) {
  return { id, context, state, target_url: `https://ci.example/${id}` };
}

export interface WorkflowRunOptions {
  name?: string | null;
  path?: string;
  status?: string | null;
  conclusion?: string | null;
  suiteId?: number;
  event?: string;
  sha?: string;
  /** The run's `workflow_id`; left out when unset. */
  workflowId?: number;
  /** `head_branch`; `main` when unset. */
  branch?: string;
}

export function workflowRun(id: number, options: WorkflowRunOptions = {}) {
  return {
    id,
    name: options.name === undefined ? "CI" : options.name,
    path: options.path ?? ".github/workflows/ci.yml",
    status: options.status === undefined ? "completed" : options.status,
    conclusion: options.conclusion === undefined ? "success" : options.conclusion,
    check_suite_id: options.suiteId,
    event: options.event ?? "push",
    head_sha: options.sha ?? "merge-1",
    head_branch: options.branch ?? "main",
    html_url: `https://github.com/acme/app/actions/runs/${id}`,
    ...(options.workflowId === undefined ? {} : { workflow_id: options.workflowId }),
  };
}

export function comment(id: number, userId: number | null, body: string | null) {
  return {
    id,
    user: userId === null ? null : { id: userId, login: `user-${userId}` },
    body,
    html_url: `https://github.com/acme/app/issues/1#issuecomment-${id}`,
  };
}

/** The workflow id fixtures give Nibfin's push workflow `nibfin-issue.yml`. */
export const nibfinPushWorkflowId = 77;

/** A run of Nibfin's push workflow on push head `sha`. */
export function nibfinPushRun(id: number, sha: string) {
  return workflowRun(id, {
    name: "Nibfin · Issue events",
    path: ".github/workflows/nibfin-issue.yml",
    sha,
    workflowId: nibfinPushWorkflowId,
  });
}

/** A completed (or pending, with `conclusion: null`) CD run of `workflow` on `sha`. */
export function cdRun(
  id: number,
  sha: string,
  workflow: string,
  conclusion: string | null = "success",
) {
  return workflowRun(id, {
    name: workflow,
    path: `.github/workflows/${workflow.toLowerCase()}.yml`,
    sha,
    status: conclusion === null ? "in_progress" : "completed",
    conclusion,
    workflowId: 100 + [...workflow].reduce((sum, c) => sum + c.charCodeAt(0), 0),
  });
}
