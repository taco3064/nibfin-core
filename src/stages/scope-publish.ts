import {
  type ActingClient,
  addAssignees,
  addBlockedBy,
  checkAssignable,
  closeIssueAs,
  createIssue,
  GitHubError,
  type IssueHandle,
  type IssueRef,
  nibfinLabels,
  readIssueId,
  readIssueRecord,
  readOriginIssues,
  readRepositoryInventory,
  type RepositoryInventory,
  setLabels,
  upsertMarkedComment,
} from "../github/index.ts";
import { codeOf } from "./pending.ts";
import { trackProgress } from "./progress.ts";
import {
  isIssueUrl,
  type PlannedIssue,
  type PlannedNewIssue,
  type RequestPlan,
} from "./scope-roles.ts";

/** The marked comment the Scope stage keeps on the request (Proposal R3.42). */
export const scopeRequestCommentKey = "scope-request";

/** What a re-read of the request found: still at Scope, no longer, or edited. */
export type Recheck = "scope" | "stopped" | "changed";

/** What publication works with besides the plan. */
export interface PublishScope {
  client: ActingClient;
  /** The request. */
  issue: IssueRef;
  /** The request's Assignee logins, from the stage's last re-read. */
  assignees: readonly string[];
  log: (line: string) => void;
  /** Re-reads the snapshot and the request text, like the stage before it acts. */
  recheck: () => Promise<Recheck>;
}

/** A planned Issue that exists: created, reused or adopted. */
export interface PublishedIssue {
  key: string;
  url: string;
}

export type PublishVerdict =
  "REPLAN_REQUIRED" | "PUBLICATION_BLOCKED" | "PARTIAL_PUBLICATION";

/**
 * How publication ended: everything read back and the request is closed; the request
 * is no longer at Scope or was edited (nothing more is written); or a person must
 * act. `error` is the failed or unconfirmed write, absent when the refresh before any
 * write found the verdict.
 */
export type PublishOutcome =
  | { kind: "published"; published: PublishedIssue[] }
  | { kind: "stopped" }
  | { kind: "changed" }
  | {
      kind: "person";
      verdict: PublishVerdict;
      reason: string;
      published: PublishedIssue[];
      error?: unknown;
    };

/** One plan entry and the Issue it is, once known. */
interface Slot {
  entry: PlannedIssue;
  /** Known for reused and adopted Issues; for new ones once created. */
  handle?: IssueHandle;
  /** Closed reused Issues are listed but not written. */
  open: boolean;
}

/** What the refresh found: the slots and the handles of the URL blockers. */
interface Prepared {
  slots: Slot[];
  blockers: Map<string, IssueHandle>;
}

type Refresh =
  | { kind: "ready"; prepared: Prepared }
  | { kind: "person"; verdict: PublishVerdict; reasons: string[]; slots: Slot[] };

const lower = (value: string) => value.toLowerCase();

function isNew(entry: PlannedIssue): entry is PlannedNewIssue {
  return !("reuse" in entry);
}

function parseIssueUrl(url: string): IssueRef {
  const [, owner, repo, , number] = new URL(url).pathname.split("/");
  return { owner, repo, number: Number(number) };
}

function repositoryOf(ref: { owner: string; repo: string }): string {
  return `${ref.owner}/${ref.repo}`;
}

function splitRepository(name: string): { owner: string; repo: string } {
  const [owner, repo] = name.split("/");
  return { owner, repo };
}

/** The `{key, url}` of every slot whose Issue exists, in plan order. */
function publishedOf(slots: readonly Slot[]): PublishedIssue[] {
  return slots.flatMap((slot) =>
    slot.handle === undefined ? [] : [{ key: slot.entry.key, url: slot.handle.url }],
  );
}

/** Issues a person discarded: closed as not planned or as a duplicate. */
function discarded(stateReason: string | null): boolean {
  return stateReason === "not_planned" || stateReason === "duplicate";
}

interface Known {
  /** Lowercase URLs of the Issue's current Blocked by. */
  blockedBy: Set<string>;
  hasScope: boolean;
}

/**
 * The read-only checks before the first write (scope skill `## Publish` and
 * `## Requests`): the request's own Issues against the plan's reuses, same-title
 * Issues in each new Issue's repository (an exact match by body is adopted, since its
 * cross-reference may lag), new edges on Issues that already have `scope` or are
 * closed, assignability, and URL blockers outside the plan's repositories. Read
 * failures are thrown.
 */
async function refresh(scope: PublishScope, plan: RequestPlan): Promise<Refresh> {
  const { client } = scope;
  const replan: string[] = [];
  const origins = await readOriginIssues(client, { ...scope.issue, url: plan.request });
  const originUrls = new Set(origins.map((origin) => lower(origin.url)));
  const reuses = new Set(
    plan.issues.flatMap((entry) => (isNew(entry) ? [] : [lower(entry.reuse)])),
  );
  const unlisted = origins.filter((origin) => !reuses.has(lower(origin.url)));
  if (unlisted.length > 0) {
    const urls = unlisted.map((origin) => origin.url).join(", ");
    replan.push(`The request's own Issues ${urls} are not in the plan.`);
  }
  const slots: Slot[] = [];
  const known = new Map<Slot, Known>();
  const inventories = new Map<string, RepositoryInventory>();
  const adopted = new Set<string>();
  for (const entry of plan.issues) {
    if (!isNew(entry)) {
      if (!originUrls.has(lower(entry.reuse))) {
        replan.push(`${entry.reuse} (${entry.key}) is no longer one of its own Issues.`);
        slots.push({ entry, open: false });
        continue;
      }
      const ref = parseIssueUrl(entry.reuse);
      const record = await readIssueRecord(client, ref);
      const handle = await readIssueId(client, ref);
      const slot = { entry, handle, open: record.state === "open" };
      slots.push(slot);
      known.set(slot, {
        blockedBy: new Set(record.blockedBy.map((issue) => lower(issue.url))),
        hasScope: record.labels.includes(nibfinLabels.scope),
      });
      continue;
    }
    let inventory = inventories.get(entry.repository);
    if (inventory === undefined) {
      inventory = await readRepositoryInventory(
        client,
        splitRepository(entry.repository),
      );
      inventories.set(entry.repository, inventory);
    }
    const slot: Slot = { entry, open: true };
    slots.push(slot);
    const open = inventory.openIssues.filter((issue) => issue.title === entry.title);
    const adoptable = open.filter(
      (issue) =>
        issue.body === entry.body &&
        !originUrls.has(lower(issue.url)) &&
        !adopted.has(lower(issue.url)),
    );
    const others = [
      ...open.filter((issue) => !adoptable.includes(issue)),
      ...inventory.closedIssues.filter(
        (issue) => issue.title === entry.title && !discarded(issue.stateReason),
      ),
    ];
    if (others.length > 0 || adoptable.length > 1) {
      const urls = [...others, ...adoptable].map((issue) => issue.url).join(", ");
      replan.push(`${entry.key}: ${urls} already has the title "${entry.title}".`);
      continue;
    }
    const [match] = adoptable;
    if (match !== undefined) {
      adopted.add(lower(match.url));
      slot.handle = await readIssueId(client, {
        ...splitRepository(entry.repository),
        number: match.number,
      });
      known.set(slot, {
        blockedBy: new Set(match.blockedBy.map((issue) => lower(issue.url))),
        hasScope: match.labels.includes(nibfinLabels.scope),
      });
      scope.log(`${entry.key}: adopting ${match.url}, created earlier`);
    }
  }
  const urlOf = (blocker: string): string | undefined => {
    if (isIssueUrl(blocker)) {
      return lower(blocker);
    }
    const url = slots.find((slot) => slot.entry.key === blocker)?.handle?.url;
    return url === undefined ? undefined : lower(url);
  };
  for (const slot of slots) {
    const state = known.get(slot);
    if (state === undefined || !(state.hasScope || !slot.open)) {
      continue;
    }
    const added = slot.entry.blockedBy.filter((blocker) => {
      const url = urlOf(blocker);
      return url === undefined || !state.blockedBy.has(url);
    });
    if (added.length > 0) {
      const why = slot.open ? "already has `scope`" : "is closed";
      const url = slot.handle?.url;
      replan.push(
        `${url} (${slot.entry.key}) ${why}, but the plan adds Blocked by ` +
          `${added.join(", ")}.`,
      );
    }
  }
  if (replan.length > 0) {
    return { kind: "person", verdict: "REPLAN_REQUIRED", reasons: replan, slots };
  }
  const blocked = await blockedReasons(scope, plan, slots);
  if (blocked.length > 0) {
    return { kind: "person", verdict: "PUBLICATION_BLOCKED", reasons: blocked, slots };
  }
  const blockers = new Map<string, IssueHandle>();
  for (const url of new Set(plan.issues.flatMap((entry) => entry.blockedBy))) {
    if (isIssueUrl(url)) {
      blockers.set(url, await readIssueId(client, parseIssueUrl(url)));
    }
  }
  return { kind: "ready", prepared: { slots, blockers } };
}

/** The repository of every open new or reused Issue. */
function openRepositories(slots: readonly Slot[]): string[] {
  const names = slots
    .filter((slot) => slot.open)
    .map((slot) =>
      isNew(slot.entry)
        ? slot.entry.repository
        : repositoryOf(parseIssueUrl(slot.entry.reuse)),
    );
  return [...new Set(names)];
}

/** Assignability and the repositories URL blockers may be in. */
async function blockedReasons(
  scope: PublishScope,
  plan: RequestPlan,
  slots: readonly Slot[],
): Promise<string[]> {
  const reasons: string[] = [];
  if (scope.assignees.length === 0) {
    reasons.push("The request has no Assignee for the new Issues.");
  }
  for (const repository of openRepositories(slots)) {
    for (const login of scope.assignees) {
      if (!(await checkAssignable(scope.client, splitRepository(repository), login))) {
        reasons.push(`${login} cannot be assigned in ${repository}.`);
      }
    }
  }
  const allowed = new Set(
    [
      repositoryOf(scope.issue),
      ...plan.issues.map((entry) =>
        isNew(entry) ? entry.repository : repositoryOf(parseIssueUrl(entry.reuse)),
      ),
    ].map(lower),
  );
  for (const entry of plan.issues) {
    for (const blocker of entry.blockedBy.filter(isIssueUrl)) {
      if (!allowed.has(lower(repositoryOf(parseIssueUrl(blocker))))) {
        reasons.push(
          `${entry.key} is Blocked by ${blocker}, outside the repositories of the plan.`,
        );
      }
    }
  }
  return reasons;
}

/** The client of the writes and `before()`, called right before each writer. */
interface Writing {
  client: ActingClient;
  before: () => void;
}

function unconfirmed(operation: string, reason: string): GitHubError {
  return new GitHubError("GITHUB_WRITE_UNCONFIRMED", operation, new Error(reason));
}

/** Planned Issues by key and URL, one per line, or "None.". */
export function listIssues(published: readonly PublishedIssue[]): string {
  return published.length === 0
    ? "None."
    : published.map((issue) => `- ${issue.key}: ${issue.url}`).join("\n");
}

function publishedBody(published: readonly PublishedIssue[]): string {
  return [
    "Nibfin's Scope stage published this request, so it is closed as completed.",
    `Issues:\n${listIssues(published)}`,
  ].join("\n\n");
}

/**
 * The writes, in order: create the new Issues and read each back; add every native
 * Blocked by edge and read both directions back; re-check; give each open Issue the
 * request's Assignees and then `scope`; re-check; comment the URLs on the request and
 * close it as completed.
 */
async function write(
  scope: PublishScope,
  writing: Writing,
  prepared: Prepared,
): Promise<PublishOutcome> {
  const { client, before: mark } = writing;
  const { slots, blockers } = prepared;
  for (const slot of slots) {
    const { entry } = slot;
    if (slot.handle !== undefined || !isNew(entry)) {
      continue;
    }
    const repo = splitRepository(entry.repository);
    mark();
    const handle = await createIssue(client, repo, entry);
    slot.handle = handle;
    scope.log(`${entry.key}: created ${handle.url}`);
    const record = await readIssueRecord(client, handle.ref);
    if (
      record.title !== entry.title ||
      record.body !== entry.body ||
      record.state !== "open"
    ) {
      throw unconfirmed(
        `create Issue "${entry.title}" in ${entry.repository}`,
        `${handle.url} did not read back with the planned title, body and state`,
      );
    }
  }
  const handleOf = (blocker: string): IssueHandle =>
    blockers.get(blocker) ??
    (slots.find((slot) => slot.entry.key === blocker)?.handle as IssueHandle);
  for (const slot of slots) {
    for (const blocker of slot.entry.blockedBy) {
      mark();
      await addBlockedBy(client, slot.handle as IssueHandle, handleOf(blocker));
    }
  }
  const first = await scope.recheck();
  if (first !== "scope") {
    return { kind: first };
  }
  for (const slot of slots.filter((candidate) => candidate.open)) {
    const handle = slot.handle as IssueHandle;
    mark();
    await addAssignees(client, handle.ref, scope.assignees);
    mark();
    const labels = await setLabels(client, handle.ref, { add: [nibfinLabels.scope] });
    if (!labels.includes(nibfinLabels.scope)) {
      throw unconfirmed(`add scope to ${handle.url}`, "The read-back labels lack scope");
    }
  }
  const second = await scope.recheck();
  if (second !== "scope") {
    return { kind: second };
  }
  const published = publishedOf(slots);
  mark();
  const comment = await upsertMarkedComment(
    client,
    scope.issue,
    scopeRequestCommentKey,
    publishedBody(published),
  );
  scope.log(`Published ${published.length} Issues (${comment.url})`);
  mark();
  await closeIssueAs(client, scope.issue, "completed");
  scope.log("Closed the request as completed");
  return { kind: "published", published };
}

/**
 * Publishes a verified `PLAN_READY` plan of a request with Core's client, never an
 * agent (Proposal R3.3–R3.6, R3.42; scope skill `## Publish` and `## Requests`).
 * A verdict found before any write is `REPLAN_REQUIRED` or `PUBLICATION_BLOCKED`
 * without an error. A write that fails or cannot be confirmed is caught and returned
 * with its error: `PARTIAL_PUBLICATION` when a write took or may have taken effect,
 * otherwise `PUBLICATION_BLOCKED`. Reads in the refresh that fail are thrown.
 */
export async function publishRequestPlan(
  scope: PublishScope,
  plan: RequestPlan,
): Promise<PublishOutcome> {
  const found = await refresh(scope, plan);
  if (found.kind === "person") {
    return {
      kind: "person",
      verdict: found.verdict,
      reason: found.reasons.join("\n"),
      published: publishedOf(found.slots),
    };
  }
  const { slots } = found.prepared;
  const progress = trackProgress(scope.client);
  // Whether a write was sent before the running writer began: those took effect,
  // since a writer that fails ends publication.
  let earlier = false;
  const before = () => {
    earlier = progress.progressed;
  };
  try {
    return await write(scope, { client: progress.client, before }, found.prepared);
  } catch (error) {
    // A refused write took no effect; any other failure of a sent write may have.
    const refused = codeOf(error) === "GITHUB_WRITE_REJECTED";
    const partial = earlier || (progress.progressed && !refused);
    return {
      kind: "person",
      verdict: partial ? "PARTIAL_PUBLICATION" : "PUBLICATION_BLOCKED",
      reason: error instanceof Error ? error.message : String(error),
      published: publishedOf(slots),
      error,
    };
  }
}
