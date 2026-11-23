import { type ActingClient, createClient } from "../github/index.ts";
import {
  type JobContext,
  readJobContext,
  runDeliverStage,
  runShapeStage,
} from "../stages/index.ts";
import { readVersion } from "./version.ts";

export interface OutputStream {
  write(text: string): unknown;
}

export interface CliIo {
  stdout: OutputStream;
  stderr: OutputStream;
}

export const usage = `Usage: nibfin <option>
       nibfin run --stage shape --repo <owner>/<repo> --issue <n> --provider <p>
                  [--model <model>]
       nibfin run --stage deliver --repo <owner>/<repo> --issue <n> --provider <p>
                  [--model <model>] [--reason ci-failure|review|cd-failure]

Options:
  --help     Show this help
  --version  Print the nibfin version

The run command reads the rest of its Job context from the environment; see
src/stages/README.md.
`;

type StageRunner = (context: JobContext, client: ActingClient) => Promise<number>;

/** What `nibfin run` uses; tests replace them. */
export interface RunDeps {
  env: NodeJS.ProcessEnv;
  createClient: (token: string, actor: JobContext["actor"]) => ActingClient;
  stages: Readonly<Record<string, StageRunner>>;
}

export const defaultRunDeps: RunDeps = {
  env: process.env,
  createClient,
  stages: {
    shape: runShapeStage,
    deliver: (context, client) => runDeliverStage(context, client),
  },
};

function stageRunner(args: readonly string[], deps: RunDeps): StageRunner | undefined {
  const index = args.indexOf("--stage");
  const stage = index === -1 ? undefined : args[index + 1];
  return stage !== undefined && Object.hasOwn(deps.stages, stage)
    ? deps.stages[stage]
    : undefined;
}

/** A failure as its code, if any, and its message. Nothing else is printed. */
function describeFailure(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const { code } = error as { code?: unknown };
  return typeof code === "string" ? `${code}: ${error.message}` : error.message;
}

async function runStage(
  args: readonly string[],
  io: CliIo,
  deps: RunDeps,
): Promise<number> {
  const runner = stageRunner(args, deps);
  if (runner === undefined) {
    io.stderr.write(usage);
    return 1;
  }
  try {
    const context = readJobContext(args, deps.env);
    return await runner(context, deps.createClient(context.token, context.actor));
  } catch (error) {
    io.stderr.write(`nibfin: ${describeFailure(error)}\n`);
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
