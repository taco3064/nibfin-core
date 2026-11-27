// Shared test support for a red `main` (#772): the review world of acme/app#1 plus
// more Issues, their merges as push heads of `main` with Nibfin's push run and CD
// runs, and the route CLI on the same fake GitHub. It holds no tests of its own.
import { capture } from "../cli/fake-io.test.ts";
import type { RunDeps } from "../cli/run.ts";
import { fakeToken } from "../github/fake-github.test.ts";
import { cdRun, nibfinPushRun, pull } from "../github/fixtures.test.ts";
import { freshReads, type Stage } from "../github/index.ts";
import type { FakePull } from "../stages/fake-delivery.test.ts";
import { type ReviewWorld, reviewWorld } from "../stages/fake-review.test.ts";
import { fakeIssue, type FakeIssue, routeIssue } from "../stages/fake-job.test.ts";
import { type FakeRunner, fakeRunner } from "./fake-runner.test.ts";
import { readRoute, type RouteState } from "./route.ts";

export const repo = { owner: "acme", repo: "app" };

/** Push heads are hex, as `nibfin route --sha` requires. */
export const sha = {
  m0: "aaaa000",
  m1: "aaaa001",
  m2: "aaaa002",
  m3: "aaaa003",
  f: "ffff001",
  g: "ffff002",
};

/** A workflow's conclusion on a push; `null` while it runs. */
export type Conclusions = Record<string, string | null>;

export interface RedMain {
  world: ReviewWorld;
  runner: FakeRunner;
  /** Issues besides acme/app#1, by number. */
  issues: Map<number, FakeIssue>;
  /** Adds an open shaped Issue with an Assignee. */
  addIssue(number: number): FakeIssue;
  /** Pushes a head to `main`: Nibfin's push run and a run per workflow. */
  push(head: string, conclusions: Conclusions): void;
  /** Sets the conclusions of a head's CD runs (a run completes). */
  complete(head: string, conclusions: Conclusions): void;
  /** Merges pull request `number` of `branch` as push head `head`. */
  merge(number: number, branch: string, head: string, conclusions: Conclusions): FakePull;
  route(issue: number): Promise<RouteState>;
  stage(issue: number): Promise<Stage>;
  /** Runs `nibfin route` with `args`; returns the dispatched inputs of this run. */
  cli(...args: string[]): Promise<{ code: number; dispatched: unknown[]; out: string }>;
  logs: string[];
}

let nextRunId = 1;

const noStage = () => Promise.reject(new Error("no stage runs in a route run"));

/**
 * The review world with acme/app#1's open pull request #7 and a green `main` head
 * `m0` that belongs to no Issue.
 */
export async function redMain(): Promise<RedMain> {
  const world = await reviewWorld();
  const { github } = world.issues;
  const { routes } = github;
  routes.set("GET /repos/acme/app", () => ({
    data: { ...world.settings, default_branch: "main", owner: { id: 5 } },
  }));
  const runner = fakeRunner(github);
  const issues = new Map<number, FakeIssue>();
  const logs: string[] = [];
  const workflowsOf = (head: string) =>
    world.pushRuns.filter((run) => (run as { head_sha: string }).head_sha === head);
  const red: RedMain = {
    world,
    runner,
    issues,
    logs,
    addIssue(number) {
      const issue = fakeIssue({ number, labels: ["scope", "shaped"] });
      routeIssue(github, issue, []);
      issues.set(number, issue);
      return issue;
    },
    push(head, conclusions) {
      world.pushRuns.push(nibfinPushRun(nextRunId++, head));
      for (const [workflow, conclusion] of Object.entries(conclusions)) {
        world.pushRuns.push(cdRun(nextRunId++, head, workflow, conclusion));
      }
      if (!world.commitPulls.has(head)) {
        world.commitPulls.set(head, []);
      }
    },
    complete(head, conclusions) {
      for (const run of workflowsOf(head) as Array<Record<string, unknown>>) {
        const conclusion = conclusions[run.name as string];
        if (conclusion !== undefined) {
          run.status = conclusion === null ? "in_progress" : "completed";
          run.conclusion = conclusion;
        }
      }
    },
    merge(number, branch, head, conclusions) {
      let found = world.pulls.find((candidate) => candidate.number === number);
      if (found === undefined) {
        found = {
          number,
          state: "closed",
          merged: true,
          head: branch,
          sha: `head-${number}`,
          mergeSha: head,
        };
        world.pulls.push(found);
      }
      Object.assign(found, { state: "closed", merged: true, mergeSha: head });
      world.commitPulls.set(head, [
        pull(number, { head: branch, merged: true, mergeSha: head }),
      ]);
      red.push(head, conclusions);
      return found;
    },
    async route(issue) {
      freshReads(github.client);
      return readRoute(github.client, repo, issue, (line) => logs.push(line));
    },
    async stage(issue) {
      return (await red.route(issue)).stage;
    },
    async cli(...args) {
      freshReads(github.client);
      const before = runner.dispatched.length;
      const deps: RunDeps = {
        env: {
          NIBFIN_GITHUB_TOKEN: fakeToken,
          NIBFIN_RUN_REPO: "acme/runner",
          NIBFIN_RUN_ID: "900",
        },
        connect: () => Promise.resolve(github.client),
        stages: {
          scope: noStage,
          shape: noStage,
          deliver: noStage,
          review: noStage,
          finish: noStage,
        },
      };
      const result = await capture(["route", "--repo", "acme/app", ...args], deps);
      const out = result.stdout + result.stderr;
      return { code: result.code, dispatched: runner.dispatched.slice(before), out };
    },
  };
  red.push(sha.m0, { CI: "success" });
  return red;
}

/** The route-run dispatch inputs of Issue `issue`. */
export const routeRun = (issue: number) => ({
  stage: "route",
  repo: "acme/app",
  issue: String(issue),
});
