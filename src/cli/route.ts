import type { ActingClient, Repo } from "../github/index.ts";
import {
  continueAfterStage,
  dispatchRoute,
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
  required,
  runUrl,
  StageError,
} from "../stages/index.ts";
import { askPerson, type CliIo, printFailure } from "./failure.ts";

/** How the CLI connects to GitHub: a client that writes as the token's account. */
export type Connect = (token: string) => Promise<ActingClient>;

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

const lineLog = (io: CliIo) => (line: string) => void io.stdout.write(`${line}\n`);

/**
 * `nibfin route`: for `--issue`, derives the Issue's route and dispatches its stage
 * (deduplicated); for `--sha` or `--branch`, maps the event to its Issue and
 * dispatches that Issue's route run, so every stage decision happens inside the
 * Issue's own concurrency group. A failure once the Issue is known sets `pending`.
 */
export async function runRoute(
  args: readonly string[],
  io: CliIo,
  env: NodeJS.ProcessEnv,
  connect: Connect,
): Promise<number> {
  let input: RouteInput;
  let client: ActingClient;
  try {
    input = readRouteInput(args, env);
    client = await connect(input.token);
  } catch (error) {
    printFailure(io, error);
    return 1;
  }
  const { repo, target } = input;
  const log = lineLog(io);
  const scope = { client, runRepo: input.runRepo, runId: input.runId, log };
  let issue: number | undefined;
  try {
    issue = await routeEvent(client, repo, target);
    const name = `${repo.owner}/${repo.repo}`;
    if (issue === undefined) {
      log(`${name}: ${JSON.stringify(target)} belongs to no Issue; nothing to route`);
    } else if ("issue" in target) {
      const state = await readRoute(client, repo, issue, log);
      if (state.route === null) {
        log(`${name}#${issue}: nothing to run (${describeStage(state.stage)})`);
      } else {
        await dispatchStage(scope, repo, issue, state.route);
      }
    } else {
      await dispatchRoute(scope, repo, issue);
    }
    return 0;
  } catch (error) {
    printFailure(io, error);
    if (issue !== undefined) {
      const url = runUrl(input.runRepo, input.runId);
      await askPerson(io, client, { ...repo, number: issue }, error, url);
    }
    return 1;
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
  context: JobContext,
  stage: "shape" | "deliver" | "review",
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
