// The entry point of Core's JavaScript Action (`action/main.mjs` is its bundle).
import { defaultActionDeps, runAction } from "./run.ts";

process.exitCode = await runAction(
  { stdout: process.stdout, stderr: process.stderr },
  defaultActionDeps,
);
