// Shared test support for routing: the execution repository `acme/runner` on a fake
// GitHub, with its default branch, its self-hosted runners, its runs by status and
// recorded dispatches. It holds no tests of its own.
import type { FakeGitHub, FakeRequest } from "../github/fake-github.test.ts";
import { paged } from "../github/fake-github.test.ts";
import type { DispatchScope } from "./dispatch.ts";

export const runRepo = { owner: "acme", repo: "runner" };
const dispatchPath =
  "/repos/acme/runner/actions/workflows/nibfin-shared-runner.yml/dispatches";

export interface FakeSelfHostedRunner {
  id: number;
  name: string;
  status: "online" | "offline";
  busy: boolean;
  labels: Array<{ id: number; name: string; type: "read-only" | "custom" }>;
}

/** A self-hosted runner with the `self-hosted` label and `labels` as custom ones. */
export function selfHostedRunner(
  id: number,
  labels: string[],
  state: Partial<Pick<FakeSelfHostedRunner, "status" | "busy">> = {},
): FakeSelfHostedRunner {
  return {
    id,
    name: `runner-${id}`,
    status: state.status ?? "online",
    busy: state.busy ?? false,
    labels: [
      { id: 1, name: "self-hosted", type: "read-only" },
      ...labels.map((name, index) => ({ id: 10 + index, name, type: "custom" as const })),
    ],
  };
}

export interface FakeRunner {
  /**
   * Self-hosted runners of the execution repository; by default one with
   * `nibfin-5`, the label of the fixtures' Assignee.
   */
  runners: FakeSelfHostedRunner[];
  /** The execution repository's owner id; by default 5, the fixtures' Assignee. */
  ownerId: number;
  /** Runs of the execution repository; each has `id`, `status`, `display_title`. */
  runs: Array<{ id: number; status: string; display_title: string }>;
  /** The inputs of each dispatch, in order. */
  dispatched: Array<Record<string, string>>;
  requests: FakeRequest[];
  logs: string[];
  scope: DispatchScope;
}

/** Routes `acme/runner` on `github`; `runId` is the current run's id. */
export function fakeRunner(
  github: FakeGitHub,
  runId: number | undefined = 900,
): FakeRunner {
  const logs: string[] = [];
  // The handlers read this object, so a test may replace `runners` or `runs`.
  const runner: FakeRunner = {
    runners: [selfHostedRunner(1, ["nibfin-5"])],
    ownerId: 5,
    runs: [],
    dispatched: [],
    requests: [],
    logs,
    scope: { client: github.client, runRepo, runId, log: (line) => logs.push(line) },
  };
  github.routes.set("GET /repos/acme/runner", () => ({
    data: { default_branch: "main", owner: { id: runner.ownerId, login: "owner" } },
  }));
  github.routes.set("GET /repos/acme/runner/actions/runners", (request) =>
    paged(runner.runners, "runners")(request),
  );
  github.routes.set("GET /repos/acme/runner/actions/runs", (request) => {
    const status = request.query.get("status");
    const runs = runner.runs.filter((run) => run.status === status);
    return paged(runs, "workflow_runs")(request);
  });
  github.routes.set(`POST ${dispatchPath}`, (request) => {
    runner.requests.push(request);
    const { inputs } = request.body as { inputs: Record<string, string> };
    runner.dispatched.push(inputs);
    const id = 1000 + runner.dispatched.length;
    return {
      data: {
        workflow_run_id: id,
        run_url: `https://api.github.com/repos/acme/runner/actions/runs/${id}`,
        html_url: `https://github.com/acme/runner/actions/runs/${id}`,
      },
    };
  });
  return runner;
}

export { dispatchPath };
