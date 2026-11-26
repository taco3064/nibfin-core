import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GitHubError } from "./errors.ts";
import {
  failure,
  type FakeRequest,
  type FakeResponse,
  fakeGitHub,
  rejection,
  sequence,
} from "./fake-github.test.ts";
import { operationOf } from "./fake-issue-record.test.ts";
import {
  checkAssignable,
  hasOriginLine,
  readOriginIssues,
  readRepositoryInventory,
} from "./request-sources.ts";

const requestUrl = "https://github.com/acme/app/issues/1";
const request = { owner: "acme", repo: "app", number: 1, url: requestUrl };
const repo = { owner: "acme", repo: "app" };

const list = <T>(nodes: T[]) => ({ totalCount: nodes.length, nodes });
const page = <T>(nodes: T[], endCursor: string | null = null) => ({
  pageInfo: { hasNextPage: endCursor !== null, endCursor },
  nodes,
});

/** A GraphQL route answering each operation with `answers[operation](cursor)`. */
function graphql(answers: Record<string, (cursor: string | null) => unknown>) {
  return (call: FakeRequest): FakeResponse => {
    const operation = operationOf(call.body) ?? "";
    const { variables } = call.body as { variables: { cursor: string | null } };
    return { data: { data: answers[operation]?.(variables.cursor) ?? null } };
  };
}

interface SourceOptions {
  url?: string;
  body?: string;
  state?: string;
  stateReason?: string | null;
  typename?: string;
}

function crossReference(options: SourceOptions = {}) {
  const url = options.url ?? "https://github.com/acme/lib/issues/7";
  return {
    __typename: "CrossReferencedEvent",
    source: {
      __typename: options.typename ?? "Issue",
      number: Number(url.split("/").at(-1)),
      url,
      title: "Add the parser",
      body: options.body ?? `Parse it.\n\n  Origin: ${requestUrl}  \n`,
      state: options.state ?? "OPEN",
      stateReason: options.stateReason ?? null,
      repository: { nameWithOwner: "acme/lib" },
      labels: list([{ name: "scope" }]),
      assignees: list([{ login: "taco" }]),
    },
  };
}

function timeline(...pages: unknown[][]) {
  return graphql({
    RequestOrigins: (cursor) => {
      const index = cursor === null ? 0 : Number(cursor);
      const next = index + 1 < pages.length ? String(index + 1) : null;
      return {
        repository: { issue: { timelineItems: page(pages[index], next) } },
      };
    },
  });
}

describe("hasOriginLine", () => {
  it("matches only the exact trimmed line", () => {
    assert.ok(hasOriginLine(`a\r\n Origin: ${requestUrl}\r\nb`, requestUrl));
    assert.ok(!hasOriginLine(`Origin: ${requestUrl}0`, requestUrl));
    assert.ok(!hasOriginLine(`See Origin: ${requestUrl}`, requestUrl));
    assert.ok(!hasOriginLine("`Origin: x`", requestUrl));
  });
});

describe("readOriginIssues", () => {
  it("keeps Issues with the origin line across pages, once each", async () => {
    const github = fakeGitHub({
      "POST /graphql": timeline(
        [crossReference(), { __typename: "ConnectedEvent" }],
        [
          crossReference(),
          crossReference({
            url: "https://github.com/acme/lib/issues/8",
            state: "CLOSED",
            stateReason: "COMPLETED",
          }),
        ],
      ),
    });
    const issues = await readOriginIssues(github.client, request);
    assert.deepEqual(issues, [
      {
        repository: "acme/lib",
        number: 7,
        url: "https://github.com/acme/lib/issues/7",
        title: "Add the parser",
        body: `Parse it.\n\n  Origin: ${requestUrl}  \n`,
        state: "open",
        stateReason: null,
        labels: ["scope"],
        assignees: ["taco"],
      },
      {
        repository: "acme/lib",
        number: 8,
        url: "https://github.com/acme/lib/issues/8",
        title: "Add the parser",
        body: `Parse it.\n\n  Origin: ${requestUrl}  \n`,
        state: "closed",
        stateReason: "completed",
        labels: ["scope"],
        assignees: ["taco"],
      },
    ]);
  });

  it("drops pull requests, other origins and discarded Issues", async () => {
    const github = fakeGitHub({
      "POST /graphql": timeline([
        crossReference({ typename: "PullRequest" }),
        { __typename: "CrossReferencedEvent", source: null },
        crossReference({ body: "Origin: https://github.com/acme/app/issues/2" }),
        crossReference({ state: "CLOSED", stateReason: "NOT_PLANNED" }),
        crossReference({ state: "CLOSED", stateReason: "DUPLICATE" }),
      ]),
    });
    assert.deepEqual(await readOriginIssues(github.client, request), []);
  });

  it("fails on a missing node, Issue or incomplete list", async () => {
    for (const answer of [
      timeline([null]),
      graphql({ RequestOrigins: () => ({ repository: { issue: null } }) }),
      timeline([
        {
          ...crossReference(),
          source: { ...crossReference().source, labels: { totalCount: 2, nodes: [] } },
        },
      ]),
    ]) {
      const github = fakeGitHub({ "POST /graphql": answer });
      const error = await rejection(readOriginIssues(github.client, request));
      assert.ok(error instanceof GitHubError);
      assert.equal(error.code, "GITHUB_READ_FAILED");
    }
  });
});

function openIssue(number: number) {
  return {
    number,
    url: `https://github.com/acme/app/issues/${number}`,
    title: `Open ${number}`,
    body: "Body",
    labels: list([{ name: "scope" }]),
    assignees: list([{ login: "taco" }]),
    issueDependenciesSummary: { totalBlockedBy: 1 },
    blockedBy: {
      nodes: [{ url: "https://github.com/acme/app/issues/3", state: "CLOSED" }],
    },
  };
}

function inventoryAnswers(visibility: unknown = "PRIVATE") {
  return graphql({
    RepositoryOpenIssues: (cursor) => ({
      repository: {
        visibility,
        issues: cursor === null ? page([openIssue(4)], "1") : page([openIssue(5)]),
      },
    }),
    RepositoryClosedIssues: () => ({
      repository: {
        issues: page([
          {
            number: 3,
            url: "https://github.com/acme/app/issues/3",
            title: "Closed",
            stateReason: "NOT_PLANNED",
            labels: list([{ name: "wontfix" }]),
          },
        ]),
      },
    }),
    RepositoryOpenPulls: () => ({
      repository: {
        pullRequests: page([
          {
            number: 9,
            url: "https://github.com/acme/app/pull/9",
            title: "Fix",
            headRefName: "nibfin/issue-4",
          },
        ]),
      },
    }),
  });
}

describe("readRepositoryInventory", () => {
  it("reads visibility, every open and closed Issue and open pull request", async () => {
    const github = fakeGitHub({ "POST /graphql": inventoryAnswers("INTERNAL") });
    const inventory = await readRepositoryInventory(github.client, repo);
    assert.equal(inventory.repository, "acme/app");
    assert.equal(inventory.visibility, "internal");
    assert.deepEqual(
      inventory.openIssues.map((issue) => issue.number),
      [4, 5],
    );
    assert.deepEqual(inventory.openIssues[0], {
      number: 4,
      url: "https://github.com/acme/app/issues/4",
      title: "Open 4",
      body: "Body",
      labels: ["scope"],
      assignees: ["taco"],
      blockedBy: [{ url: "https://github.com/acme/app/issues/3", state: "closed" }],
    });
    assert.deepEqual(inventory.closedIssues, [
      {
        number: 3,
        url: "https://github.com/acme/app/issues/3",
        title: "Closed",
        stateReason: "not_planned",
        labels: ["wontfix"],
      },
    ]);
    assert.deepEqual(inventory.openPullRequests, [
      {
        number: 9,
        url: "https://github.com/acme/app/pull/9",
        title: "Fix",
        headRef: "nibfin/issue-4",
      },
    ]);
  });

  for (const visibility of [null, "SECRET"]) {
    it(`fails on visibility ${String(visibility)} instead of guessing`, async () => {
      const github = fakeGitHub({ "POST /graphql": inventoryAnswers(visibility) });
      const error = await rejection(readRepositoryInventory(github.client, repo));
      assert.ok(error instanceof GitHubError);
      assert.equal(error.code, "GITHUB_READ_FAILED");
      assert.match(error.message, /read the Issues and pull requests of acme\/app/);
    });
  }

  it("fails on a missing repository", async () => {
    const github = fakeGitHub({
      "POST /graphql": graphql({ RepositoryOpenIssues: () => ({ repository: null }) }),
    });
    const error = await rejection(readRepositoryInventory(github.client, repo));
    assert.ok(error instanceof GitHubError);
  });
});

describe("checkAssignable", () => {
  const path = "GET /repos/acme/lib/assignees/taco";
  const lib = { owner: "acme", repo: "lib" };

  it("is true on 204", async () => {
    const github = fakeGitHub({ [path]: { status: 204 } });
    assert.equal(await checkAssignable(github.client, lib, "taco"), true);
  });

  it("is false on 404, without a retry", async () => {
    const github = fakeGitHub({ [path]: failure(404, "Not Found") });
    assert.equal(await checkAssignable(github.client, lib, "taco"), false);
    assert.equal(github.calls.length, 1);
    assert.deepEqual(github.waits, []);
  });

  it("retries other failures, then fails the read", async () => {
    const github = fakeGitHub({ [path]: sequence(failure(500), { status: 204 }) });
    assert.equal(await checkAssignable(github.client, lib, "taco"), true);
    assert.equal(github.calls.length, 2);
    const broken = fakeGitHub({ [path]: failure(500) });
    const error = await rejection(checkAssignable(broken.client, lib, "taco"));
    assert.ok(error instanceof GitHubError);
    assert.equal(error.code, "GITHUB_READ_FAILED");
    assert.equal(broken.calls.length, 4);
  });
});
