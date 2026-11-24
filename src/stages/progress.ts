import type { ActingClient } from "../github/index.ts";

/**
 * Whether a stage run made progress (#674): it wrote to GitHub through its client
 * (any request other than a GET or a GraphQL query: comment, label, PR, merge,
 * close), pushed, or found a PR head other than the one it started with. The stage
 * records pushes and moved heads with `mark`.
 */
export interface Progress {
  /** The stage's client; its writes count as progress. */
  readonly client: ActingClient;
  readonly progressed: boolean;
  mark(): void;
}

type Request = ActingClient["request"];

/** True for a request that changes GitHub; Nibfin's GraphQL calls only read. */
export function isWriteRoute(route: unknown): boolean {
  const text =
    typeof route === "string"
      ? route
      : `${(route as { method?: string }).method ?? "GET"} `;
  return !text.startsWith("GET ") && !text.startsWith("POST /graphql");
}

/** Wraps `client` so that its writes mark progress. */
export function trackProgress(client: ActingClient): Progress {
  let progressed = false;
  const request = Object.assign((route: unknown, parameters?: unknown) => {
    if (isWriteRoute(route)) {
      progressed = true;
    }
    return (client.request as (route: unknown, parameters?: unknown) => unknown)(
      route,
      parameters,
    );
  }, client.request) as Request;
  return {
    client: { actor: client.actor, paginate: client.paginate, request },
    get progressed() {
      return progressed;
    },
    mark() {
      progressed = true;
    },
  };
}
