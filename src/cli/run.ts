import { type ActingClient, connectClient } from "../github/index.ts";
import {
  type FinishContext,
  isWait,
  type JobContext,
  readFinishContext,
  readJobContext,
  runDeliverStage,
  runFinishStage,
  runReviewStage,
  runScopeStage,
  runShapeStage,
  runUrl,
} from "../stages/index.ts";
import { askPerson, type CliIo, printFailure } from "./failure.ts";
import { renderWorkflowsCommand } from "./render-workflows.ts";
import { type Connect, lineLog, routeAfterStage, runRoute } from "./route.ts";
import { readVersion } from "./version.ts";

export type { CliIo, OutputStream } from "./failure.ts";

export const usage = `Usage: nibfin <option>
       nibfin run --stage scope --repo <owner>/<repo> --issue <n> --provider <p>
                  [--model <model>]
       nibfin run --stage shape --repo <owner>/<repo> --issue <n> --provider <p>
                  [--model <model>]
       nibfin run --stage deliver --repo <owner>/<repo> --issue <n> --provider <p>
                  [--model <model>] [--reason ci-failure|review|cd-failure|conflict]
       nibfin run --stage review --repo <owner>/<repo> --issue <n> --provider <p>
                  [--model <model>]
       nibfin run --stage finish --repo <owner>/<repo> --issue <n>
       nibfin route --repo <owner>/<repo> (--issue <n> | --sha <sha> | --branch <b>)
       nibfin render-workflows --set execution|peer --channel own|user [--image <ref>]
                  --default-branch <branch> [--workflow <name>]...

Options:
  --help     Show this help
  --version  Print the nibfin version

The run and route commands read the rest of their context from the environment;
see src/stages/README.md and src/route/README.md. render-workflows prints the
rendered workflow files as JSON; see src/workflows/README.md.
`;

type StageName = "scope" | "shape" | "deliver" | "review" | "finish";
type StageRunner = (context: JobContext, client: ActingClient) => Promise<number>;
/** The finish stage runs no agent, so its context has no agent fields (#755). */
type FinishRunner = (context: FinishContext, client: ActingClient) => Promise<number>;
interface StageRunners {
  scope: StageRunner;
  shape: StageRunner;
  deliver: StageRunner;
  review: StageRunner;
  finish: FinishRunner;
}

/** What `nibfin run` and `nibfin route` use; tests replace them. */
export interface RunDeps {
  env: NodeJS.ProcessEnv;
  connect: Connect;
  stages: Readonly<StageRunners>;
}

export const defaultRunDeps: RunDeps = {
  env: process.env,
  connect: (token, log) => connectClient(token, {}, log),
  stages: {
    scope: runScopeStage,
    shape: runShapeStage,
    deliver: (context, client) => runDeliverStage(context, client),
    review: (context, client) => runReviewStage(context, client),
    finish: (context, client) => runFinishStage(context, client),
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
 * Any failure once the client exists sets `pending` on the Issue and exits 1, except
 * `STAGE_WRITER_ACTIVE`: a wait that writes nothing and exits 0, so a non-zero exit
 * always means a person must act.
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
  let context: FinishContext;
  let runner: (client: ActingClient) => Promise<number>;
  let client: ActingClient;
  try {
    if (stage === "finish") {
      const finish = readFinishContext(args, deps.env);
      context = finish;
      runner = (acting) => deps.stages.finish(finish, acting);
    } else {
      const job = readJobContext(args, deps.env);
      context = job;
      runner = (acting) => deps.stages[stage](job, acting);
    }
    client = await deps.connect(context.token, lineLog(io));
  } catch (error) {
    printFailure(io, error);
    return 1;
  }
  try {
    const code = await runner(client);
    if (code === 0) {
      await routeAfterStage(io, client, context, stage);
    }
    return code;
  } catch (error) {
    printFailure(io, error);
    if (isWait(error)) {
      return 0;
    }
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
  if (args[0] === "render-workflows") {
    return renderWorkflowsCommand(args.slice(1), io);
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
