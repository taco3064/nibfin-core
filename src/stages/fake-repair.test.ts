// Shared test support for the repair agent (#778): the delivery world with the
// execution repository, an Issue repository inventory, an open pull request and a
// stop. It holds no tests of its own.
import { type FakeRequest, paged } from "../github/fake-github.test.ts";
import { operationOf } from "../github/fake-issue-record.test.ts";
import { type FakeRunner, fakeRunner } from "../route/fake-runner.test.ts";
import { type DeliveryWorld, deliveryWorld } from "./fake-delivery.test.ts";
import { git } from "./fake-git.test.ts";
import { type AgentStep, answerCommentQuery } from "./fake-job.test.ts";
import { requestPerson } from "./pending.ts";
import type { RepairStageDeps } from "./repair-agent.ts";

const page = <T>(nodes: T[]) => ({
  pageInfo: { hasNextPage: false, endCursor: null },
  nodes,
});
const list = <T>(nodes: T[]) => ({ totalCount: nodes.length, nodes });

export interface RepairWorld extends DeliveryWorld {
  runner: FakeRunner;
  /** `PUBLIC` unless a test changes it. */
  visibility: string;
  /** The open Issues of acme/app the inventory lists, besides #1. */
  openIssues: unknown[];
  repairDeps: RepairStageDeps;
  /** How often `reroute` ran. */
  reroutes: number;
}

/** One open Issue as the inventory query answers it. */
export function inventoryIssue(number: number, title: string, blockedBy: string[] = []) {
  return {
    number,
    url: `https://github.com/acme/app/issues/${number}`,
    title,
    body: "Hidden body",
    labels: list([{ name: "scope" }]),
    assignees: list([{ login: "taco" }]),
    issueDependenciesSummary: { totalBlockedBy: blockedBy.length },
    blockedBy: { nodes: blockedBy.map((url) => ({ url, state: "OPEN" })) },
  };
}

function graphql(world: RepairWorld) {
  return (request: FakeRequest) => {
    const answer = (data: unknown) => ({ data: { data } });
    switch (operationOf(request.body)) {
      case "RepositoryOpenIssues":
        return answer({
          repository: { visibility: world.visibility, issues: page(world.openIssues) },
        });
      case "RepositoryClosedIssues":
        return answer({ repository: { issues: page([]) } });
      case "RepositoryOpenPulls":
        return answer({ repository: { pullRequests: page([]) } });
      default:
        return answerCommentQuery([world.issues.main], request);
    }
  };
}

/** The delivery world of acme/app#1 (`scope`) with the repair agent's reads routed. */
export async function repairWorld(steps: AgentStep[] = []): Promise<RepairWorld> {
  const delivery = await deliveryWorld({
    noShape: true,
    steps,
    issue: { labels: ["scope"] },
  });
  const runner = fakeRunner(delivery.issues.github);
  const world = delivery as RepairWorld;
  world.runner = runner;
  world.visibility = "PUBLIC";
  world.openIssues = [inventoryIssue(1, "Add the widget")];
  world.reroutes = 0;
  world.repairDeps = {
    ...delivery.agent.deps,
    reroute: () => {
      world.reroutes += 1;
      return Promise.resolve();
    },
  };
  const { routes } = world.issues.github;
  routes.set("POST /graphql", graphql(world));
  routes.set("PATCH /repos/acme/app/issues/1", (request) => {
    world.issues.main.body = (request.body as { body: string }).body;
    return { data: {} };
  });
  routes.set("GET /repos/acme/app/pulls/7/files", (request) =>
    paged([{ filename: "src/widget.ts" }, { filename: "src/widget.test.ts" }])(request),
  );
  return world;
}

/** Pushes `nibfin/issue-1` and opens pull request #7 with `checks` on its head. */
export function openPull(world: DeliveryWorld, checks: unknown[]): string {
  git(world.fixture.other, "push", "--quiet", "origin", "main:refs/heads/nibfin/issue-1");
  const sha = world.fixture.remoteHead("nibfin/issue-1")!;
  world.required = ["verify"];
  world.pulls.push({
    number: 7,
    state: "open",
    merged: false,
    head: "nibfin/issue-1",
    sha,
    mergeSha: null,
  });
  world.checkRuns.set(sha, checks);
  return sha;
}

/** Stops acme/app#1 on `error` in run 800 of the execution repository. */
export async function stopIssue(world: DeliveryWorld, error: unknown, runId = 800) {
  const url = `https://github.com/acme/runner/actions/runs/${runId}`;
  const issue = { owner: "acme", repo: "app", number: 1 };
  await requestPerson(world.issues.github.client, issue, error, url);
}
