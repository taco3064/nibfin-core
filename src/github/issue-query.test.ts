import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GitHubError } from "./errors.ts";
import {
  type FakeGitHub,
  fakeActor,
  fakeGitHub,
  paged,
  rejection,
} from "./fake-github.test.ts";
import { comment, issue, type IssueOptions, pull } from "./fixtures.test.ts";
import { queryGraphql, readIssueRecord } from "./issue-query.ts";
import { freshReads } from "./read-cache.ts";

const target = { owner: "acme", repo: "app", number: 1 };
const issuePath = "GET /repos/acme/app/issues/1";
const ref = (branch: string) => `GET /repos/acme/app/git/ref/heads/${branch}`;
const fix = (k: number) => `nibfin/issue-1-cd-${k}`;

interface Setup {
  issue?: IssueOptions & { title?: string; body?: string | null };
  blockedBy?: unknown[];
  comments?: unknown[];
  pulls?: Record<string, unknown[]>;
  refs?: string[];
}

function world(setup: Setup = {}): FakeGitHub {
  const { title, body, ...options } = setup.issue ?? {};
  const github = fakeGitHub({
    [issuePath]: {
      data: {
        ...issue(1, options),
        title: title ?? "T",
        body: body === undefined ? "B" : body,
      },
    },
    "GET /repos/acme/app/issues/1/dependencies/blocked_by": paged(setup.blockedBy ?? []),
    "GET /repos/acme/app/issues/1/comments": paged(setup.comments ?? []),
    "GET /repos/acme/app/pulls": (request) => {
      const head = request.query.get("head")?.replace("acme:", "") ?? "";
      return paged(setup.pulls?.[head] ?? [])(request);
    },
  });
  for (const name of setup.refs ?? []) {
    github.routes.set(ref(name), { data: { ref: `refs/heads/${name}` } });
  }
  return github;
}

const graphqlCalls = (github: FakeGitHub) =>
  github.calls.filter((call) => call.path === "/graphql");

async function expectReadFailure(promise: Promise<unknown>, message: RegExp) {
  const error = await rejection(promise);
  assert.ok(error instanceof GitHubError, String(error));
  assert.equal(error.code, "GITHUB_READ_FAILED");
  assert.match(String((error.cause as Error).message), message);
  return error;
}

describe("readIssueRecord", () => {
  it("reads the Issue, dependencies, comments and branches in one query", async () => {
    const forkPull = pull(9, { state: "closed" });
    const github = world({
      issue: {
        state: "closed",
        stateReason: "not_planned",
        labels: ["scope", "shaped"],
        assignees: [{ id: 5, login: "taco" }],
        totalBlockedBy: 1,
        title: "Widget",
        body: null,
      },
      blockedBy: [
        issue(7, { owner: "other", repo: "lib", state: "closed", labels: ["delivered"] }),
      ],
      comments: [
        { ...comment(3, fakeActor.id, "<!-- nibfin:shape -->\nPlan"), edits: 2 },
        comment(4, null, null),
      ],
      pulls: {
        "nibfin/issue-1": [
          pull(10, { merged: true, mergeSha: "m10" }),
          { ...forkPull, head: { ...forkPull.head, repo: { full_name: "fork/app" } } },
          pull(12, { head: "nibfin/issue-1-other" }),
          pull(11, { state: "closed" }),
        ],
      },
      refs: ["nibfin/issue-1"],
    });
    const record = await readIssueRecord(github.client, target);
    assert.deepEqual(record, {
      issue: target,
      state: "closed",
      stateReason: "not_planned",
      url: "https://github.com/acme/app/issues/1",
      title: "Widget",
      body: "",
      labels: ["scope", "shaped"],
      assignees: [{ id: 5, login: "taco" }],
      blockedBy: [
        {
          owner: "other",
          repo: "lib",
          number: 7,
          state: "closed",
          labels: ["delivered"],
          url: "https://github.com/other/lib/issues/7",
        },
      ],
      comments: [
        {
          id: 3,
          authorId: fakeActor.id,
          body: "<!-- nibfin:shape -->\nPlan",
          url: "https://github.com/acme/app/issues/1#issuecomment-3",
          versions: 2,
        },
        {
          id: 4,
          authorId: null,
          body: "",
          url: "https://github.com/acme/app/issues/1#issuecomment-4",
          versions: 1,
        },
      ],
      branches: {
        delivery: {
          name: "nibfin/issue-1",
          exists: true,
          pullRequests: [
            {
              number: 11,
              state: "closed",
              merged: false,
              headRef: "nibfin/issue-1",
              headSha: "head-11",
              baseRef: "main",
              mergeCommitSha: null,
              url: "https://github.com/acme/app/pull/11",
            },
            {
              number: 10,
              state: "closed",
              merged: true,
              headRef: "nibfin/issue-1",
              headSha: "head-10",
              baseRef: "main",
              mergeCommitSha: "m10",
              url: "https://github.com/acme/app/pull/10",
            },
          ],
        },
        fixes: [],
        current: record.branches.delivery,
        nextFixBranch: fix(1),
      },
    });
    assert.equal(record.branches.current, record.branches.delivery);
    assert.deepEqual(
      github.calls.map((call) => `${call.method} ${call.path}`),
      ["POST /graphql"],
    );
    const { variables } = graphqlCalls(github)[0].body as {
      variables: Record<string, unknown>;
    };
    assert.deepEqual(variables, {
      owner: "acme",
      repo: "app",
      number: 1,
      branch: "nibfin/issue-1",
      ref: "refs/heads/nibfin/issue-1",
      fixQuery: "issue-1-cd-",
      fix1: fix(1),
      fix2: fix(2),
      fix3: fix(3),
    });
  });

  it("maps an open Issue without a state reason", async () => {
    const record = await readIssueRecord(world().client, target);
    assert.deepEqual([record.state, record.stateReason], ["open", null]);
  });

  it("probes fix branches by pull request or ref across batches", async () => {
    const merged = (k: number) => [pull(20 + k, { head: fix(k), merged: true })];
    const github = world({
      pulls: { [fix(1)]: merged(1), [fix(2)]: merged(2), [fix(4)]: merged(4) },
      refs: [fix(3), "nibfin/issue-1-cd-x"],
    });
    const record = await readIssueRecord(github.client, target);
    assert.deepEqual(
      record.branches.fixes.map((probe) => [
        probe.name,
        probe.exists,
        probe.pullRequests.length,
      ]),
      [
        [fix(1), false, 1],
        [fix(2), false, 1],
        [fix(3), true, 0],
        [fix(4), false, 1],
      ],
    );
    assert.equal(record.branches.current.name, fix(4));
    assert.equal(record.branches.nextFixBranch, fix(5));
    const batches = graphqlCalls(github).map(
      (call) => (call.body as { variables: Record<string, unknown> }).variables,
    );
    assert.equal(batches.length, 2);
    assert.deepEqual(batches[1], {
      owner: "acme",
      repo: "app",
      fix1: fix(4),
      fix2: fix(5),
      fix3: fix(6),
    });
  });

  it("reads comments past the first 100 with follow-up queries", async () => {
    const comments = Array.from({ length: 250 }, (_, i) => comment(i + 1, 7, `c${i}`));
    const github = world({ comments });
    const record = await readIssueRecord(github.client, target);
    assert.equal(record.comments.length, 250);
    assert.equal(record.comments.at(-1)?.body, "c249");
    const cursors = graphqlCalls(github).map(
      (call) => (call.body as { variables: { cursor?: string } }).variables.cursor,
    );
    assert.deepEqual(cursors, [undefined, "2", "3"]);
  });

  it("fails instead of reporting fewer blockers than the summary counts", async () => {
    const github = world({ issue: { totalBlockedBy: 2 }, blockedBy: [issue(2)] });
    await expectReadFailure(
      readIssueRecord(github.client, target),
      /^Read 1 of 2 dependencies$/,
    );
  });

  it("fails for a pull request number or a missing Issue", async () => {
    const pullRequest = world({ issue: { pullRequest: true } });
    await expectReadFailure(
      readIssueRecord(pullRequest.client, target),
      /^acme\/app#1 is a pull request$/,
    );
    const missing = fakeGitHub();
    const error = await expectReadFailure(
      readIssueRecord(missing.client, target),
      /^Could not resolve to an issue numbered 1\.$/,
    );
    assert.equal(error.operation, "read acme/app#1");
  });

  it("fails when a REST-backed part fails", async () => {
    const github = world();
    github.routes.set(ref("nibfin/issue-1"), { status: 403, data: { message: "No" } });
    const error = await expectReadFailure(readIssueRecord(github.client, target), /No/);
    assert.match(error.message, /^read acme\/app#1: read failed \(HTTP 403\)$/);
  });
});

/** A minimal Issue-record answer that `patch` may change. */
function recordData(patch: (repository: Record<string, unknown>) => void = () => {}) {
  const pulls = () => ({ pageInfo: { hasNextPage: false }, nodes: [] });
  const repository: Record<string, unknown> = {
    issueOrPullRequest: {
      __typename: "Issue",
      state: "OPEN",
      stateReason: null,
      url: "u",
      title: "T",
      body: "",
      labels: { totalCount: 0, nodes: [] },
      assignees: { totalCount: 0, nodes: [] },
      issueDependenciesSummary: { totalBlockedBy: 0 },
      blockedBy: { nodes: [] },
      comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
    },
    delivery: pulls(),
    ref: null,
    fixRefs: { pageInfo: { hasNextPage: false }, nodes: [] },
    fix1: pulls(),
    fix2: pulls(),
    fix3: pulls(),
  };
  patch(repository);
  return { data: { data: { repository } } };
}

function answering(answer: unknown, more: Record<string, unknown> = {}) {
  return fakeGitHub({ "GRAPHQL IssueRecord": answer as never, ...more });
}

describe("readIssueRecord with an incomplete answer", () => {
  const issueNode = (repository: Record<string, unknown>) =>
    repository.issueOrPullRequest as Record<string, unknown>;

  it("accepts the minimal answer", async () => {
    const record = await readIssueRecord(answering(recordData()).client, target);
    assert.deepEqual(record.comments, []);
  });

  it("skips missing pulls and refs and reads an organization author", async () => {
    const data = recordData((repository) => {
      repository.delivery = { pageInfo: { hasNextPage: false }, nodes: [null] };
      repository.fixRefs = { pageInfo: { hasNextPage: false }, nodes: [null] };
      issueNode(repository).comments = {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [
          { databaseId: 3, body: "b", url: "u", author: {}, userContentEdits: null },
        ],
      };
    });
    const record = await readIssueRecord(answering(data).client, target);
    assert.deepEqual(record.comments, [
      { id: 3, authorId: null, body: "b", url: "u", versions: 1 },
    ]);
    assert.deepEqual(record.branches.delivery.pullRequests, []);
    assert.equal(record.branches.nextFixBranch, fix(1));
  });

  it("fails when GitHub answers without the repository", async () => {
    const github = answering({ data: { data: { repository: null } } });
    await expectReadFailure(
      readIssueRecord(github.client, target),
      /^acme\/app#1 was not found$/,
    );
  });

  const cases: Array<[string, (repository: Record<string, unknown>) => void, RegExp]> = [
    [
      "no Issue and no error",
      (repository) => {
        repository.issueOrPullRequest = null;
      },
      /^acme\/app#1 was not found$/,
    ],
    [
      "more than 100 pull requests of a branch",
      (repository) => {
        repository.delivery = { pageInfo: { hasNextPage: true }, nodes: [] };
      },
      /^More than 100 pull requests of nibfin\/issue-1$/,
    ],
    [
      "more than 100 fix branches",
      (repository) => {
        repository.fixRefs = { pageInfo: { hasNextPage: true }, nodes: [null] };
      },
      /^More than 100 fix branches$/,
    ],
    [
      "a missing Assignee",
      (repository) => {
        issueNode(repository).assignees = { totalCount: 1, nodes: [null] };
      },
      /^Read 0 of 1 Assignees$/,
    ],
    [
      "a missing label of a blocker",
      (repository) => {
        const node = issueNode(repository);
        node.issueDependenciesSummary = { totalBlockedBy: 1 };
        const blocker = {
          number: 2,
          state: "OPEN",
          url: "u2",
          repository: { name: "app", owner: { login: "acme" } },
          labels: { totalCount: 2, nodes: [{ name: "scope" }] },
        };
        node.blockedBy = { nodes: [blocker] };
      },
      /^Read 1 of 2 labels of #2$/,
    ],
    [
      "a missing comment",
      (repository) => {
        issueNode(repository).comments = {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [null],
        };
      },
      /^GraphQL returned a missing comment$/,
    ],
    [
      "no pull requests of a fix branch",
      (repository) => {
        delete repository.fix2;
        repository.fixRefs = {
          pageInfo: { hasNextPage: false },
          nodes: [{ name: "issue-1-cd-1" }],
        };
      },
      /^GraphQL returned no pull requests of nibfin\/issue-1-cd-2$/,
    ],
  ];
  for (const [name, patch, message] of cases) {
    it(`fails on ${name}`, async () => {
      const github = answering(recordData(patch));
      await expectReadFailure(readIssueRecord(github.client, target), message);
    });
  }

  it("fails when a follow-up query answers without its data", async () => {
    const comments = answering(
      recordData((repository) => {
        issueNode(repository).comments = {
          pageInfo: { hasNextPage: true, endCursor: "2" },
          nodes: [],
        };
      }),
      { "GRAPHQL IssueComments": { data: { data: { repository: null } } } },
    );
    await expectReadFailure(
      readIssueRecord(comments.client, target),
      /^GraphQL returned no comments$/,
    );
    comments.routes.set("GRAPHQL IssueComments", {
      data: { data: { repository: { issue: null } } },
    });
    freshReads(comments.client);
    await expectReadFailure(
      readIssueRecord(comments.client, target),
      /^GraphQL returned no comments$/,
    );
    const refs = ["issue-1-cd-1", "issue-1-cd-2", "issue-1-cd-3"].map((name) => ({
      name,
    }));
    const fixes = answering(
      recordData((repository) => {
        repository.fixRefs = { pageInfo: { hasNextPage: false }, nodes: refs };
      }),
      { "GRAPHQL IssueFixBranches": { data: { data: { repository: null } } } },
    );
    await expectReadFailure(
      readIssueRecord(fixes.client, target),
      /^GraphQL returned no pull requests of nibfin\/issue-1-cd-4$/,
    );
  });
});

describe("queryGraphql", () => {
  const query = "query Probe { viewer { login } }";

  it("returns the data of an answer without errors", async () => {
    const github = fakeGitHub({ "POST /graphql": { data: { data: { viewer: 1 } } } });
    assert.deepEqual(await queryGraphql(github.client, "probe", query, {}), {
      viewer: 1,
    });
  });

  it("fails on GraphQL errors or a missing data", async () => {
    const answers: Array<[unknown, RegExp]> = [
      [{ data: null, errors: [{ message: "Bad field" }] }, /^Bad field$/],
      [{ errors: [{ type: "X" }] }, /^GraphQL returned no data$/],
      [{}, /^GraphQL returned no data$/],
    ];
    for (const [data, message] of answers) {
      const github = fakeGitHub({ "POST /graphql": { data } });
      const error = await expectReadFailure(
        queryGraphql(github.client, "probe", query, {}),
        message,
      );
      assert.equal(error.operation, "probe");
    }
  });
});
