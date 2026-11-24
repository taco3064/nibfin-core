import type { Octokit } from "@octokit/core";

/**
 * True for a request that only reads GitHub: a GET or HEAD, or a GraphQL query
 * (Nibfin sends no GraphQL mutations; one would count as a write).
 */
export function isReadRequest(method: string, url: string, body?: unknown): boolean {
  if (method === "GET" || method === "HEAD") {
    return true;
  }
  const path = new URL(url, "https://api.github.com").pathname;
  if (method !== "POST" || path !== "/graphql") {
    return false;
  }
  const query = (body as { query?: unknown } | undefined)?.query;
  return typeof query !== "string" || !/^\s*mutation\b/.test(query);
}

type Response = Awaited<ReturnType<Octokit["request"]>>;

/** A request as sent: method, full URL (with query string) and body. */
export interface SentRequest {
  method: string;
  url: string;
  body: unknown;
}

/** How Octokit sends request options that went through `endpoint.merge`. */
export function sentRequest(octokit: Octokit, options: object): SentRequest {
  const parse = octokit.request.endpoint.parse as (options: object) => SentRequest;
  const { method, url, body } = parse(options);
  return { method, url, body };
}

const clearers = new WeakMap<object, () => void>();

/**
 * Keeps the answers of read requests for the rest of the Job until the next write,
 * agent run or push (`freshReads`). GET requests (each page of a list) and GraphQL
 * queries are keyed by method, full URL and, for GraphQL, the body; identical reads
 * share one answer, also while it is in flight. Failed answers are not kept. Any other
 * request clears the cache before it is sent and again once it settled, so the
 * confirm and read-back reads of a write go to GitHub. Every caller gets its own copy
 * of the data.
 */
export function installReadCache(octokit: Octokit): void {
  let entries = new Map<string, Promise<Response>>();
  const clear = () => {
    entries = new Map();
  };
  clearers.set(octokit, clear);
  octokit.hook.wrap("request", async (request, options): Promise<Response> => {
    const { method, url, body } = sentRequest(octokit, options);
    if (!isReadRequest(method, url, body)) {
      clear();
      try {
        return await request(options);
      } finally {
        clear();
      }
    }
    const key = `${method} ${url} ${body === undefined ? "" : JSON.stringify(body)}`;
    const cache = entries;
    let answer = cache.get(key);
    if (answer === undefined) {
      const pending = Promise.resolve(request(options));
      cache.set(key, pending);
      pending.catch(() => cache.delete(key));
      answer = pending;
    }
    const response = await answer;
    return { ...response, data: structuredClone<unknown>(response.data) };
  });
}

/** Lets `wrapper` (a client built over `client`) clear the same read cache. */
export function shareReadCache<T extends object>(wrapper: T, client: object): T {
  const clear = clearers.get(client);
  if (clear !== undefined) {
    clearers.set(wrapper, clear);
  }
  return wrapper;
}

/**
 * Drops every kept read of `client`, so the next reads see GitHub's current state.
 * Called at the start and end of every agent run, after every push and before the
 * post-stage route. A client without a cache is left alone.
 */
export function freshReads(client: object): void {
  clearers.get(client)?.();
}
