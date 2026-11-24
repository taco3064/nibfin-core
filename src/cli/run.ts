import { type ActingClient, connectClient } from "../github/index.ts";
import {
  type JobContext,
  readJobContext,
  runDeliverStage,
  runReviewStage,
  runShapeStage,
  runUrl,
} from "../stages/index.ts";
import { askPerson, type CliIo, printFailure } from "./failure.ts";
import { type Connect, lineLog, routeAfterStage, runRoute } from "./route.ts";
import { readVersion } from "./version.ts";

export type { CliIo, OutputStream } from "./failure.ts";

export const usage = `Usage: nibfin <option>
       nibfin run --stage shape --repo <owner>/<repo> --issue <n> --provider <p>
                  [--model <model>]
       nibfin run --stage deliver --repo <owner>/<repo> --issue <n> --provider <p>
                  [--model <model>] [--reason ci-failure|review|cd-failure]
       nibfin run --stage review --repo <owner>/<repo> --issue <n> --provider <p>
                  [--model <model>]
       nibfin route --repo <owner>/<repo> (--issue <n> | --sha <sha> | --branch <b>)

Options:
  --help     Show this help
  --version  Print the nibfin version

The run and route commands read the rest of their context from the environment;
see src/stages/README.md and src/route/README.md.
`;

type StageName = "shape" | "deliver" | "review";
type StageRunner = (context: JobContext, client: ActingClient) => Promise<number>;

/** What `nibfin run` and `nibfin route` use; tests replace them. */
export interface RunDeps {
  env: NodeJS.ProcessEnv;
  connect: Connect;
  stages: Readonly<Record<StageName, StageRunner>>;
}

export const defaultRunDeps: RunDeps = {
  env: process.env,
  connect: (token, log) => connectClient(token, {}, log),
  stages: {
    shape: runShapeStage,
    deliver: (context, client) => runDeliverStage(context, client),
    review: (context, client) => runReviewStage(context, client),
  },
};

function stageName(args: readonly string[], deps: RunDeps): StageName | undefined {
  const index = args.indexOf("--stage");
  const stage = index === -1 ? undefined : args[index + 1];
  return stage !== undefined && Object.hasOwn(deps.stages, stage)
    ? (stage as StageName)
    : undefined;
}

/**
 * Runs one stage, then continues the Issue from GitHub state (`routeAfterStage`).
 * Any failure once the client exists sets `pending` on the Issue.
 */
async function runStage(
  args: readonly string[],
  io: CliIo,
  deps: RunDeps,
): Promise<number> {
  const stage = stageName(args, deps);
  if (stage === undefined) {
    io.stderr.write(usage);
    return 1;
  }
  let context: JobContext;
  let client: ActingClient;
  try {
    context = readJobContext(args, deps.env);
    client = await deps.connect(context.token, lineLog(io));
  } catch (error) {
    printFailure(io, error);
    return 1;
  }
  try {
    const code = await deps.stages[stage](context, client);
    if (code === 0) {
      await routeAfterStage(io, client, context, stage);
    }
    return code;
  } catch (error) {
    printFailure(io, error);
    const issue = { ...context.repo, number: context.issue };
    await askPerson(io, client, issue, error, runUrl(context.runRepo, context.runId));
    return 1;
  }
}

export async function run(
  args: readonly string[],
  io: CliIo,
  deps: RunDeps = defaultRunDeps,
): Promise<number> {
  if (args[0] === "run") {
    return runStage(args.slice(1), io, deps);
  }
  if (args[0] === "route") {
    return runRoute(args.slice(1), io, deps.env, deps.connect);
  }
  const option = args.length === 1 ? args[0] : undefined;
  if (option === "--version") {
    io.stdout.write(`${readVersion()}\n`);
    return 0;
  }
  if (option === "--help") {
    io.stdout.write(usage);
    return 0;
  }
  io.stderr.write(usage);
  return 1;
}
