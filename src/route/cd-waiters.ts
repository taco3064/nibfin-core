import {
  type ActingClient,
  type CdState,
  issuesOfCommit,
  readBaseHeads,
  readCdRuns,
  readDefaultBranch,
  readIssueRecord,
  type Repo,
} from "../github/index.ts";
import { type DispatchScope, dispatchRoute } from "./dispatch.ts";

const hasFailure = (cd: CdState) => cd.runs.some((run) => run.state === "failed");

/**
 * Wakes the Issues that may wait on push head `sha` of the default branch (#772):
 * once `sha`'s CD is complete (Nibfin's push run present, no run pending), and `sha`
 * is on the page of push heads, the candidates are the head just newer than `sha`
 * when its CD has a failure, and the heads older than `sha` walking back while their
 * CD has a failure. Each Issue of a candidate (every Issue merged to it, #771), when
 * open and not in `exclude`, gets one route run (a repeated wake is harmless,
 * R4.35). Returns the woken Issues.
 */
export async function cdWaiters(
  scope: DispatchScope,
  repo: Repo,
  sha: string,
  exclude: readonly number[],
): Promise<number[]> {
  const { client, log } = scope;
  const name = `${repo.owner}/${repo.repo}`;
  const base = await readDefaultBranch(client, repo);
  const cd = await readCdRuns(client, repo, base, sha);
  const complete = cd.nibfinRunPresent && cd.runs.every((run) => run.state !== "pending");
  if (!complete || cd.nibfinWorkflowId === undefined) {
    log(`${name}@${sha}: CD is not complete on ${base}; no waiting Issue is woken`);
    return [];
  }
  const heads = await readBaseHeads(client, repo, base, cd.nibfinWorkflowId);
  const at = heads.indexOf(sha);
  if (at === -1) {
    log(`${name}@${sha}: not among the latest push heads of ${base}; nothing to wake`);
    return [];
  }
  const candidates = await redNeighbours(client, repo, base, heads, at);
  const woken: number[] = [];
  for (const candidate of candidates) {
    for (const issue of await issuesOfCommit(client, repo, candidate)) {
      if (exclude.includes(issue) || woken.includes(issue)) {
        continue;
      }
      if (!(await isOpen(client, repo, issue))) {
        continue;
      }
      log(`${name}#${issue}: its red merge ${candidate} may wait on ${sha}; waking it`);
      await dispatchRoute(scope, repo, { issue });
      woken.push(issue);
    }
  }
  if (woken.length === 0) {
    log(`${name}@${sha}: no Issue waits on it`);
  }
  return woken;
}

/** The red head just newer than `heads[at]`, then the red heads older than it. */
async function redNeighbours(
  client: ActingClient,
  repo: Repo,
  base: string,
  heads: readonly string[],
  at: number,
): Promise<string[]> {
  const red = async (head: string) =>
    hasFailure(await readCdRuns(client, repo, base, head));
  const found: string[] = [];
  if (at > 0 && (await red(heads[at - 1]))) {
    found.push(heads[at - 1]);
  }
  for (const head of heads.slice(at + 1)) {
    if (!(await red(head))) {
      break;
    }
    found.push(head);
  }
  return found;
}

async function isOpen(client: ActingClient, repo: Repo, issue: number) {
  return (await readIssueRecord(client, { ...repo, number: issue })).state === "open";
}
