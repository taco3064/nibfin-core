import { type ActingClient, freshReads, type Repo } from "../github/index.ts";
import {
  continueAfterStage,
  deleteIssueBranches,
  dispatchRoute,
  type DispatchScope,
  dispatchStage,
  readRoute,
  routeEvent,
  type RouteTarget,
} from "../route/index.ts";
import {
  describeStage,
  type JobContext,
  positiveInteger,
  readNextAction,
  readRepo,
  type RepairClock,
  type RepairOutcome,
  required,
  runRepair,
  runUrl,
  StageError,
  systemClock,
} from "../stages/index.ts";
import { askPerson, type CliIo, printFailure } from "./failure.ts";

/**
 * How the CLI connects to GitHub: a client that writes as the token's account and
 * writes its rate-limit waits to `log` (the Job log).
 */
export type Connect = (
  token: string,
  log: (line: string) => void,
) => Promise<ActingClient>;

interface RouteInput {
  repo: Repo;
  target: RouteTarget;
  token: string;
  runRepo: Repo;
  runId: number | undefined;
}

const routeFlags = ["--repo", "--issue", "--sha", "--branch"];

function invalid(message: string): StageError {
  return new StageError("STAGE_INPUT_INVALID", message);
}

/** `--<name> <value>` pairs of `nibfin route`. */
function routeOptions(args: readonly string[]): Map<string, string> {
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!routeFlags.includes(flag)) {
      throw invalid(`${JSON.stringify(flag)} is not a known option`);
    }
    if (value === undefined || value.startsWith("--")) {
      throw invalid(`${flag} needs a value`);
    }
    if (options.has(flag)) {
      throw invalid(`${flag} is given more than once`);
    }
    options.set(flag, value);
  }
  return options;
}

function readTarget(options: Map<string, string>): RouteTarget {
  const given = ["--issue", "--sha", "--branch"].filter((flag) => options.has(flag));
  if (given.length !== 1) {
    throw invalid("exactly one of --issue, --sha and --branch is needed");
  }
  const value = options.get(given[0])!;
  if (given[0] === "--issue") {
    return { issue: positiveInteger(value, "--issue") };
  }
  if (given[0] === "--sha") {
    if (!/^[0-9a-f]{7,64}$/.test(value)) {
      throw invalid("--sha must be a commit SHA");
    }
    return { sha: value };
  }
  return { branch: value };
}

/** The `nibfin route` options and environment; names a bad field, never its value. */
export function readRouteInput(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): RouteInput {
  const options = routeOptions(args);
  return {
    repo: readRepo(options.get("--repo"), "--repo"),
    target: readTarget(options),
    token: required(env.NIBFIN_GITHUB_TOKEN, "NIBFIN_GITHUB_TOKEN"),
    runRepo: readRepo(env.NIBFIN_RUN_REPO, "NIBFIN_RUN_REPO"),
    runId:
      env.NIBFIN_RUN_ID === undefined
        ? undefined
        : positiveInteger(env.NIBFIN_RUN_ID, "NIBFIN_RUN_ID"),
  };
}

/** Writes one line to the Job log (stdout). */
export const lineLog = (io: CliIo) => (line: string) => void io.stdout.write(`${line}\n`);

/**
 * `nibfin route`: for `--issue`, derives the Issue's route, deletes a closed Issue's
 * branches (#700), then dispatches its stage (deduplicated); for `--sha` or
 * `--branch`, maps the event to its Issues (a commit can belong to several, #771)
 * and dispatches one route run per Issue in turn, so every stage decision happens
 * inside the Issue's own concurrency group. A failure once an Issue is known sets
 * `pending` on that Issue only; the other Issues are still dispatched, and the
 * command exits 1 when any failed. For `--issue`, an Issue with `pending` and nothing
 * to route runs the repair stage (#777, `runRepair`); when it removes `pending`, the
 * Issue is routed and dispatched once more. A failure of the repair stage itself sets
 * `pending` with the line `- Stage: \`repair\`` (Proposal R4.50).
 */
export async function runRoute(
  args: readonly string[],
  io: CliIo,
  env: NodeJS.ProcessEnv,
  connect: Connect,
  clock: RepairClock = systemClock,
): Promise<number> {
  let input: RouteInput;
  let client: ActingClient;
  let issues: number[];
  try {
    input = readRouteInput(args, env);
    client = await connect(input.token, lineLog(io));
    issues = await routeEvent(client, input.repo, input.target);
  } catch (error) {
    printFailure(io, error);
    return 1;
  }
  const { repo, target } = input;
  const log = lineLog(io);
  const scope = { client, runRepo: input.runRepo, runId: input.runId, log };
  const name = `${repo.owner}/${repo.repo}`;
  if (issues.length === 0) {
    log(`${name}: ${JSON.stringify(target)} belongs to no Issue; nothing to route`);
    return 0;
  }
  const url = runUrl(input.runRepo, input.runId);
  let code = 0;
  for (const issue of issues) {
    const ref = { ...repo, number: issue };
    try {
      if ("issue" in target) {
        const state = await readRoute(client, repo, issue, log);
        if (!state.open) {
          await deleteIssueBranches(client, repo, issue, log);
        }
        if (state.route === null && state.repair !== null) {
          log(`${name}#${issue}: repair (${state.repair.kind})`);
          let outcome: RepairOutcome;
          try {
            outcome = await runRepair(client, ref, state.repair, clock, log);
          } catch (error) {
            // The repair stage failed: R4.5's comment names it, so it does not start
            // again for this stop (Proposal R4.50).
            printFailure(io, error);
            await askPerson(io, client, ref, error, url, "repair");
            code = 1;
            continue;
          }
          if (outcome === "released") {
            freshReads(client);
            await dispatchIssue(scope, repo, issue, name);
          }
        } else if (state.route === null) {
          log(`${name}#${issue}: nothing to run (${describeStage(state.stage)})`);
        } else {
          await dispatchStage(scope, repo, issue, state.route);
        }
      } else {
        await dispatchRoute(scope, repo, issue);
      }
    } catch (error) {
      printFailure(io, error);
      await askPerson(io, client, ref, error, url);
      code = 1;
    }
  }
  return code;
}

/** After the repair stage released `pending`: the one re-dispatch (Proposal R4.42). */
async function dispatchIssue(
  scope: DispatchScope,
  repo: Repo,
  issue: number,
  name: string,
): Promise<void> {
  const state = await readRoute(scope.client, repo, issue, scope.log);
  if (state.route === null) {
    scope.log(`${name}#${issue}: nothing to run (${describeStage(state.stage)})`);
  } else {
    await dispatchStage(scope, repo, issue, state.route);
  }
}

/**
 * After `nibfin run` exited 0: reads the next-action file and continues the Issue
 * (wakes, then its deduplicated route, or `pending` on no progress). Without
 * `NIBFIN_NEXT_FILE` nothing is dispatched.
 */
export async function routeAfterStage(
  io: CliIo,
  client: ActingClient,
  context: Pick<
    JobContext,
    "repo" | "issue" | "reason" | "runRepo" | "runId" | "nextFile"
  >,
  stage: "scope" | "shape" | "deliver" | "review" | "finish",
): Promise<void> {
  if (context.nextFile === undefined) {
    io.stdout.write("NIBFIN_NEXT_FILE is not set; nothing is dispatched\n");
    return;
  }
  if (context.runRepo === undefined) {
    throw invalid("NIBFIN_RUN_REPO is missing");
  }
  const record = await readNextAction(context.nextFile);
  const scope = {
    client,
    runRepo: context.runRepo,
    runId: context.runId,
    log: lineLog(io),
  };
  const finished = {
    repo: context.repo,
    issue: context.issue,
    stage,
    reason: context.reason ?? null,
  };
  await continueAfterStage(scope, finished, record);
}
