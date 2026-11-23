// Shared test support: a fake publisher behind `fetch` and a fake process runner.
// It holds no tests of its own.
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CapturedResult, ProcessRequest } from "../agent/process.ts";
import type { FetchLike, RunTool } from "./install-context.ts";

export {
  makeTempDir,
  parentSecrets,
  withParentEnvironment,
} from "../agent/fake-cli.test.ts";

export interface FakeRoute {
  body?: string | Uint8Array;
  status?: number;
  /** Answered with a 302 to this URL; served only when the caller follows it. */
  redirectTo?: string;
}

export interface FakeFetch {
  fetch: FetchLike;
  urls: string[];
}

function respond(route: FakeRoute | undefined): Response {
  if (route === undefined) {
    return new Response("not found", { status: 404 });
  }
  const body = route.body ?? "";
  const bytes = typeof body === "string" ? body : new Uint8Array(body);
  return new Response(bytes, { status: route.status ?? 200 });
}

/** A publisher that serves `routes` by exact URL and 404s everything else. */
export function fakeFetch(routes: Record<string, FakeRoute>): FakeFetch {
  const urls: string[] = [];
  const fetch: FetchLike = (url, init) => {
    urls.push(url);
    const route = routes[url];
    if (route?.redirectTo === undefined) {
      return Promise.resolve(respond(route));
    }
    if (init.redirect !== "follow") {
      const headers = { location: route.redirectTo };
      return Promise.resolve(new Response(null, { status: 302, headers }));
    }
    urls.push(route.redirectTo);
    return Promise.resolve(respond(routes[route.redirectTo]));
  };
  return { fetch, urls };
}

/** A fetch that fails the test when called. */
export const unusedFetch: FetchLike = (url) => {
  throw new Error(`unexpected download of ${url}`);
};

export function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export interface RecordedRun extends ProcessRequest {
  /** The archive bytes, when the request is a tar extraction. */
  archive?: string;
}

export type RunHandler = (
  request: ProcessRequest,
) => Promise<Partial<CapturedResult> | void> | Partial<CapturedResult> | void;

export interface FakeRun {
  run: RunTool;
  requests: ProcessRequest[];
}

/** Records every request; `handler` may write files and shape the result. */
export function fakeRun(handler: RunHandler = () => undefined): FakeRun {
  const requests: ProcessRequest[] = [];
  const run: RunTool = async (request) => {
    requests.push(request);
    const result = (await handler(request)) ?? {};
    return {
      status: { exitCode: 0, signal: null },
      stdout: "",
      stderr: "",
      ...result,
    };
  };
  return { run, requests };
}

/** Writes `files` (relative path to text) below `dir`. */
export async function writeTree(dir: string, files: Record<string, string>) {
  for (const [path, text] of Object.entries(files)) {
    const file = join(dir, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, text);
  }
}

/** A tar stand-in that "extracts" `files` into the `-C` directory. */
export function fakeTar(files: Record<string, string>): RunHandler {
  return async (request) => {
    const target = request.args[request.args.indexOf("-C") + 1];
    await writeTree(target, files);
  };
}

/** A fresh workspace and a cache directory beside it, under `root`. */
export async function makeJobDirs(root: string) {
  const base = await mkdtemp(join(root, "job-"));
  const workspace = join(base, "workspace");
  await mkdir(workspace);
  return { workspace, cacheDir: join(base, "cache") };
}
