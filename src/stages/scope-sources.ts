import {
  type ActingClient,
  type IssueSnapshot,
  type OriginIssue,
  readIssueText,
  readOriginIssues,
  readRepositoryInventory,
  type RepositoryInventory,
} from "../github/index.ts";
import { fenced, type PromptSection } from "./prompt.ts";

/** The request as the stage read it. */
export interface RequestSource {
  url: string;
  /** `owner/repo`. */
  repository: string;
  title: string;
  body: string;
  /** Assignee logins, in GitHub's order. */
  assignees: string[];
}

/**
 * What the Investigation reads, all from the stage's own reads: the request, its own
 * Issues and the request repository's inventory (with its visibility).
 */
export interface ScopeSources {
  request: RequestSource;
  origins: OriginIssue[];
  /** The request repository's inventory first. */
  inventories: RepositoryInventory[];
}

export async function readRequestSource(
  client: ActingClient,
  snapshot: IssueSnapshot,
): Promise<RequestSource> {
  const { issue } = snapshot;
  const text = await readIssueText(client, issue);
  return {
    url: issue.url,
    repository: `${issue.owner}/${issue.repo}`,
    ...text,
    assignees: issue.assignees.map((assignee) => assignee.login),
  };
}

/** The request, its own Issues and the request repository's inventory. */
export async function readScopeSources(
  client: ActingClient,
  snapshot: IssueSnapshot,
): Promise<ScopeSources> {
  const { issue } = snapshot;
  const request = await readRequestSource(client, snapshot);
  const origins = await readOriginIssues(client, issue);
  const inventory = await readRepositoryInventory(client, issue);
  return { request, origins, inventories: [inventory] };
}

/** True when the request's title or body differs between two reads. */
export function requestTextChanged(before: RequestSource, after: RequestSource): boolean {
  return before.title !== after.title || before.body !== after.body;
}

function list(values: readonly string[]): string {
  return values.length === 0 ? "none" : values.join(", ");
}

function describeRequest(request: RequestSource): string {
  const body = request.body.trim() === "" ? "(no description)" : fenced(request.body);
  return [
    `URL: ${request.url}`,
    `Title: ${request.title}`,
    `Assignees: ${list(request.assignees)}`,
    "",
    body,
  ].join("\n");
}

function visibilitySection(sources: ScopeSources): PromptSection {
  const [own, ...others] = sources.inventories;
  const lines = [
    `- ${own.repository} (the request repository): ${own.visibility}`,
    ...others.map((inventory) => `- ${inventory.repository}: ${inventory.visibility}`),
  ];
  return { title: "Visibility", body: lines.join("\n") };
}

function stateOf(issue: { state: string; stateReason: string | null }): string {
  return issue.stateReason === null
    ? issue.state
    : `${issue.state} (${issue.stateReason})`;
}

function originsSection(origins: readonly OriginIssue[]): PromptSection {
  const body =
    origins.length === 0
      ? "None: no Issue with this request's origin line is open or kept."
      : origins
          .map((issue) =>
            [
              `### ${issue.url}`,
              "",
              `Repository: ${issue.repository}`,
              `State: ${stateOf(issue)}`,
              `Title: ${issue.title}`,
              `Labels: ${list(issue.labels)}`,
              `Assignees: ${list(issue.assignees)}`,
              "",
              fenced(issue.body),
            ].join("\n"),
          )
          .join("\n\n");
  return { title: "The request's own Issues", body };
}

function inventorySection(inventory: RepositoryInventory): PromptSection {
  const open = inventory.openIssues.map((issue) =>
    [
      `#### ${issue.url}`,
      "",
      `Title: ${issue.title}`,
      `Labels: ${list(issue.labels)}`,
      `Assignees: ${list(issue.assignees)}`,
      `Blocked by: ${list(issue.blockedBy.map((item) => `${item.url} (${item.state})`))}`,
      "",
      fenced(issue.body),
    ].join("\n"),
  );
  const closed = inventory.closedIssues.map(
    (issue) =>
      `- ${issue.url} (${stateOf({ state: "closed", stateReason: issue.stateReason })})` +
      `: ${issue.title} [labels: ${list(issue.labels)}]`,
  );
  const pulls = inventory.openPullRequests.map(
    (pull) => `- ${pull.url} (head ${pull.headRef}): ${pull.title}`,
  );
  const body = [
    `Visibility: ${inventory.visibility}`,
    "",
    "### Open Issues",
    "",
    open.length === 0 ? "None." : open.join("\n\n"),
    "",
    "### Closed Issues",
    "",
    closed.length === 0 ? "None." : closed.join("\n"),
    "",
    "### Open pull requests",
    "",
    pulls.length === 0 ? "None." : pulls.join("\n"),
  ].join("\n");
  return {
    title: `Inventory of ${inventory.repository} (${inventory.visibility})`,
    body,
  };
}

/** The request, Visibility, the request's own Issues and every inventory. */
export function scopeSections(sources: ScopeSources): PromptSection[] {
  return [
    { title: "Request", body: describeRequest(sources.request) },
    visibilitySection(sources),
    originsSection(sources.origins),
    ...sources.inventories.map(inventorySection),
  ];
}

/** Whether each request Assignee can be assigned in each inventoried repository. */
export interface Assignability {
  repository: string;
  login: string;
  assignable: boolean;
}

/** One line per request Assignee and repository (Scope runs only with an Assignee). */
export function assignabilitySection(rows: readonly Assignability[]): PromptSection {
  const lines = rows.map(
    (row) =>
      `- ${row.login} in ${row.repository}: ` +
      (row.assignable ? "assignable" : "not assignable"),
  );
  return { title: "Assignability", body: lines.join("\n") };
}
