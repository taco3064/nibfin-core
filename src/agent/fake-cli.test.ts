// Shared test support: fake CLIs as small Node scripts in repository-local
// temporary directories. It holds no tests of its own.
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ByteSink, Command } from "./process.ts";

/** Ignored by Git; see `.gitignore`. */
export const testRoot = fileURLToPath(new URL("../../.test-tmp/", import.meta.url));

export async function makeTempDir(prefix: string): Promise<string> {
  await mkdir(testRoot, { recursive: true });
  return mkdtemp(join(testRoot, prefix));
}

/** A fresh Git repository to act as the Job workspace. */
export async function makeWorkspace(parent: string): Promise<string> {
  const workspace = await mkdtemp(join(parent, "workspace-"));
  execFileSync("git", ["init", "--quiet"], { cwd: workspace });
  return workspace;
}

export interface FakeScenario {
  stdout?: string;
  stderr?: string;
  exit?: number;
  /** Exit code of `auth status` / `login status`. */
  statusExit?: number;
  /** Written to the path after `-o`. */
  lastMessage?: string;
  /** Files written relative to the working directory. */
  files?: Record<string, string>;
  /** The environment variable whose value is recorded as `home`. */
  homeVariable?: string;
}

export interface FakeCall {
  args: string[];
  cwd: string;
  home: string | null;
  stdin: string;
}

const script = `
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const here = dirname(process.argv[1]);
const scenario = JSON.parse(readFileSync(join(here, "scenario.json"), "utf8"));
const args = process.argv.slice(2);
const isStatus = args[1] === "status";
let stdin = "";
if (!isStatus) {
  for await (const chunk of process.stdin) stdin += chunk;
}
const home = process.env[scenario.homeVariable ?? ""] ?? null;
const call = { args, cwd: process.cwd(), home, stdin };
appendFileSync(join(here, "calls.jsonl"), JSON.stringify(call) + "\\n");
if (isStatus) process.exit(scenario.statusExit ?? 0);
for (const [path, text] of Object.entries(scenario.files ?? {})) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}
const o = args.indexOf("-o");
if (scenario.lastMessage !== undefined) writeFileSync(args[o + 1], scenario.lastMessage);
process.stdout.write(scenario.stdout ?? "");
process.stderr.write(scenario.stderr ?? "");
process.exitCode = scenario.exit ?? 0;
`;

export interface FakeCli {
  command: Command;
  calls(): Promise<FakeCall[]>;
}

export async function createFakeCli(
  parent: string,
  scenario: FakeScenario,
): Promise<FakeCli> {
  const dir = await mkdtemp(join(parent, "fake-"));
  await writeFile(join(dir, "fake.mjs"), script);
  await writeFile(join(dir, "scenario.json"), JSON.stringify(scenario));
  return {
    command: { command: process.execPath, args: [join(dir, "fake.mjs")] },
    calls: async () => {
      const text = await readFile(join(dir, "calls.jsonl"), "utf8").catch(() => "");
      return text
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as FakeCall);
    },
  };
}

export interface CapturedSink extends ByteSink {
  text(): string;
}

export function captureSink(): CapturedSink {
  const chunks: string[] = [];
  return {
    write: (chunk) => chunks.push(Buffer.from(chunk).toString("utf8")),
    text: () => chunks.join(""),
  };
}

export function jsonLines(...events: unknown[]): string {
  return events.map((event) => `${JSON.stringify(event)}\n`).join("");
}
