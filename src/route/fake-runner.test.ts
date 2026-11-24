// Shared test support for routing: the execution repository `acme/runner` on a fake
// GitHub, with its default branch, its runs by status and recorded dispatches. It
// holds no tests of its own.
import type { FakeGitHub, FakeRequest } from "../github/fake-github.test.ts";
import { paged } from "../github/fake-github.test.ts";
import type { DispatchScope } from "./dispatch.ts";

export const runRepo = { owner: "acme", repo: "runner" };
const dispatchPath =
  "/repos/acme/runner/actions/workflows/nibfin-shared-runner.yml/dispatches";

export interface FakeRunner {
  /** Runs of the execution repository; each has `id`, `status`, `display_title`. */
  runs: Array<{ id: number; status: string; display_title: string }>;
  /** The inputs of each dispatch, in order. */
  dispatched: Array<Record<string, string>>;
  requests: FakeRequest[];
  logs: string[];
  scope: DispatchScope;
}

/** Routes `acme/runner` on `github`; `runId` is the current run's id. */
export function fakeRunner(github: FakeGitHub, runId: number | undefined = 900) {
  const runner: Omit<FakeRunner, "scope"> = {
    runs: [],
    dispatched: [],
    requests: [],
    logs: [],
  };
  github.routes.set("GET /repos/acme/runner", { data: { default_branch: "main" } });
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
  const scope: DispatchScope = {
    client: github.client,
    runRepo,
    runId,
    log: (line) => runner.logs.push(line),
  };
  return { ...runner, scope } satisfies FakeRunner;
}

export { dispatchPath };
