// Shared test support for the CLI: runs it with captured output. It holds no tests of
// its own.
import { run, type RunDeps } from "./run.ts";

export async function capture(args: readonly string[], deps?: RunDeps) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(
    args,
    {
      stdout: { write: (text: string) => out.push(text) },
      stderr: { write: (text: string) => err.push(text) },
    },
    deps,
  );
  return { code, stdout: out.join(""), stderr: err.join("") };
}
