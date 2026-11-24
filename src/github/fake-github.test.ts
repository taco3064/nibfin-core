import {
  type ActingClient,
  type Actor,
  type ClientOptions,
  createClient,
  type NibfinOctokit,
} from "./client.ts";
import {
  answerRecordQuery,
  operationOf,
  recordOperations,
  type RestGet,
} from "./fake-issue-record.test.ts";

/** Test support: a fake GitHub REST API behind a real Octokit (no network). */

export const fakeToken = "ghs_fakeTokenThatMustNeverBeLogged";
export const fakeActor: Actor = { id: 42, login: "nibfin-bot" };
export const repo = { owner: "acme", repo: "app" };

export interface FakeRequest {
  method: string;
  /** The decoded path, such as `/repos/acme/app/git/ref/heads/nibfin/issue-1`. */
  path: string;
  query: URLSearchParams;
  body: unknown;
  headers: Record<string, string>;
}

export interface FakeResponse {
  status?: number;
  data?: unknown;
  headers?: Record<string, string>;
}

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type Handler = (request: FakeRequest) => FakeResponse | Promise<FakeResponse>;
export type Route = Handler | FakeResponse;

export interface FakeGitHub {
  client: NibfinOctokit & ActingClient;
  /** The lines the client wrote to the Job log (rate-limit waits). */
  log: string[];
  calls: FakeRequest[];
  /** Calls other than GET and GraphQL queries (Nibfin sends no mutations). */
  writes: () => FakeRequest[];
  routes: Map<string, Route>;
}

/**
 * A fake API: routes are keyed `"<METHOD> <decoded path>"`; others answer 404. Nibfin's
 * Issue-record GraphQL queries are answered from the REST routes (see
 * `fake-issue-record.test.ts`) unless a route `"GRAPHQL <operation>"` answers them
 * (a handler may return `undefined` to leave a request to the REST routes).
 */
export function fakeGitHub(routes: Record<string, Route> = {}): FakeGitHub {
  const table = new Map(Object.entries(routes));
  const calls: FakeRequest[] = [];
  const answer = async (request: FakeRequest): Promise<FakeResponse> => {
    const route = table.get(`${request.method} ${request.path}`);
    if (route === undefined) {
      return { status: 404, data: { message: "Not Found" } };
    }
    return typeof route === "function" ? route(request) : route;
  };
  const restGet: RestGet = async (path, query = {}) => {
    const response = await answer({
      method: "GET",
      path,
      query: new URLSearchParams(query),
      body: undefined,
      headers: {},
    });
    return {
      status: response.status ?? 200,
      data: response.data,
      headers: response.headers,
    };
  };
  const route = async (request: FakeRequest): Promise<FakeResponse> => {
    const operation = request.path === "/graphql" ? operationOf(request.body) : undefined;
    if (operation === undefined || !recordOperations.includes(operation)) {
      return answer(request);
    }
    const own = table.get(`GRAPHQL ${operation}`);
    const answered = typeof own === "function" ? await own(request) : own;
    // A `GRAPHQL <operation>` handler that answers nothing leaves it to the REST routes.
    if (answered !== undefined) {
      return answered;
    }
    return answerRecordQuery(request.body, restGet, () => [...table.keys()]);
  };
  const fetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const method = init?.method ?? "GET";
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const text = typeof init?.body === "string" ? init.body : undefined;
    const request: FakeRequest = {
      method,
      path: decodeURIComponent(url.pathname),
      query: url.searchParams,
      body: text === undefined ? undefined : JSON.parse(text),
      headers,
    };
    calls.push(request);
    const response = await route(request);
    const status = response.status ?? 200;
    const answer = new Response(
      status === 204 ? null : JSON.stringify(response.data ?? {}),
      { status, headers: { "content-type": "application/json", ...response.headers } },
    );
    // A constructed Response has an empty `url`; Octokit's paginate parses it.
    Object.defineProperty(answer, "url", { value: url.href });
    return answer;
  };
  const log: string[] = [];
  const client = createClient(
    fakeToken,
    fakeActor,
    testClientOptions(fetch),
    (line) => void log.push(line),
  );
  return {
    client,
    log,
    calls,
    writes: () =>
      calls.filter((call) => call.method !== "GET" && call.path !== "/graphql"),
    routes: table,
  };
}

/** A limiter that runs every job at once, so tests do not wait between writes. */
const immediate = {
  key: () => ({
    schedule: (
      _options: unknown,
      run: (...args: unknown[]) => unknown,
      ...args: unknown[]
    ) => run(...args),
  }),
};

/**
 * Client options for tests: requests go to `fetch`, retries and rate-limit waits take
 * no time, and writes are not spaced out.
 */
export function testClientOptions(fetch: FetchLike): ClientOptions {
  return {
    request: { fetch },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    throttle: {
      retryAfterBaseValue: 0,
      write: immediate,
      search: immediate,
      notifications: immediate,
    } as unknown as ClientOptions["throttle"],
    retry: { retryAfterBaseValue: 0 },
  };
}

/** A handler that fails like a dropped connection (no response). */
export function networkError(): Handler {
  return () => {
    throw new TypeError("fetch failed");
  };
}

/** A handler answering `status` with a GitHub-style message. */
export function failure(status: number, message = "Failure"): FakeResponse {
  return { status, data: { message } };
}

/**
 * A paginated list honoring `per_page` and `page`, with a `link` header to the next
 * page. With `key`, pages are wrapped as `{ total_count, [key]: items }`.
 */
export function paged(items: readonly unknown[], key?: string): Handler {
  return (request) => {
    const perPage = Number(request.query.get("per_page") ?? "30");
    const page = Number(request.query.get("page") ?? "1");
    const slice = items.slice((page - 1) * perPage, page * perPage);
    const headers: Record<string, string> = {};
    if (page * perPage < items.length) {
      const next = new URL(`https://api.github.com${request.path}`);
      request.query.forEach((value, name) => next.searchParams.set(name, value));
      next.searchParams.set("page", String(page + 1));
      headers.link = `<${next.href}>; rel="next"`;
    }
    const data = key ? { total_count: items.length, [key]: slice } : slice;
    return { data, headers };
  };
}

/** Answers from a list of handlers in turn; the last one repeats. */
export function sequence(...handlers: Route[]): Handler {
  let index = 0;
  return async (request) => {
    const route = handlers[Math.min(index, handlers.length - 1)];
    index += 1;
    return typeof route === "function" ? route(request) : route;
  };
}

/** Collects a promise's rejection, failing when it resolves. */
export async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected a rejection");
}
