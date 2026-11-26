import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GitHubError, type GitHubErrorCode } from "./errors.ts";
import {
  type FakeGitHub,
  type FakeRequest,
  type FakeResponse,
  failure,
  fakeActor,
  fakeGitHub,
  networkError,
  paged,
  rejection,
  repo,
  type Route,
} from "./fake-github.test.ts";
import { comment, issue, pull } from "./fixtures.test.ts";
import {
  closeDelivered,
  closeIssueAs,
  commentMarker,
  deleteBranch,
  ensurePullRequest,
  findMarkedComment,
  setLabels,
  upsertMarkedComment,
} from "./writes.ts";

const target = { owner: "acme", repo: "app", number: 1 };
const branch = "nibfin/issue-1";

async function expectCode(promise: Promise<unknown>, code: GitHubErrorCode) {
  const error = await rejection(promise);
  assert.ok(error instanceof GitHubError, String(error));
  assert.equal(error.code, code);
  return error;
}

/**
 * How a write route answers: `ok` applies it; `lost` fails without applying (no
 * response); `applied-then-502` applies it and answers 502; a number fails with it.
 */
type Outcome = "ok" | "lost" | "applied-then-502" | number;

function answer(outcome: Outcome, apply: () => FakeResponse): FakeResponse {
  if (outcome === "lost") {
    throw new TypeError("fetch failed");
  }
  if (typeof outcome === "number") {
    return failure(outcome);
  }
  const response = apply();
  return outcome === "ok" ? response : failure(502);
}

describe("ensurePullRequest", () => {
  const request = { branch, base: "main", title: "T", body: "B" };

  function pullsFake(open: unknown[], create: (request: FakeRequest) => FakeResponse) {
    return fakeGitHub({
      "GET /repos/acme/app/pulls": (call) => paged(open)(call),
      "POST /repos/acme/app/pulls": (call) => create(call),
    });
  }

  it("reuses the open pull request of the branch without writing", async () => {
    const github = pullsFake([pull(7)], () => failure(500));
    assert.equal((await ensurePullRequest(github.client, repo, request)).number, 7);
    assert.deepEqual(github.writes(), []);
    assert.equal(github.calls[0]?.query.get("state"), "open");
  });

  it("creates the pull request when there is none", async () => {
    const github = pullsFake([], () => ({ status: 201, data: pull(8) }));
    const created = await ensurePullRequest(github.client, repo, request);
    assert.equal(created.number, 8);
    assert.deepEqual(github.writes()[0]?.body, {
      head: branch,
      base: "main",
      title: "T",
      body: "B",
    });
  });

  it("re-reads after an unknown outcome and reuses the confirmed PR", async () => {
    const open: unknown[] = [];
    const github = pullsFake(open, () => {
      open.push(pull(9));
      return failure(502);
    });
    assert.equal((await ensurePullRequest(github.client, repo, request)).number, 9);
    assert.equal(github.writes().length, 1);
  });

  it("reports an unconfirmed create when the re-read finds nothing", async () => {
    const lost = pullsFake([], () => {
      throw new TypeError("fetch failed");
    });
    const error = await expectCode(
      ensurePullRequest(lost.client, repo, request),
      "GITHUB_WRITE_UNCONFIRMED",
    );
    assert.equal((error.cause as { status: number }).status, 500);
    let reads = 0;
    const flaky = fakeGitHub({
      "GET /repos/acme/app/pulls": () => (++reads === 1 ? { data: [] } : failure(500)),
      "POST /repos/acme/app/pulls": failure(503),
    });
    await expectCode(
      ensurePullRequest(flaky.client, repo, request),
      "GITHUB_WRITE_UNCONFIRMED",
    );
  });

  it("reuses the pull request after a 422 already exists", async () => {
    const open: unknown[] = [];
    const exists = {
      status: 422,
      data: {
        message: "Validation Failed",
        errors: [
          { code: "custom" },
          { message: "A pull request already exists for acme:x." },
        ],
      },
    };
    const github = pullsFake(open, () => {
      open.push(pull(10));
      return exists;
    });
    assert.equal((await ensurePullRequest(github.client, repo, request)).number, 10);
    const vanished = pullsFake([], () => exists);
    await expectCode(
      ensurePullRequest(vanished.client, repo, request),
      "GITHUB_WRITE_REJECTED",
    );
  });

  it("rejects other client errors", async () => {
    for (const response of [
      failure(422, "Validation Failed"),
      { status: 422, data: { errors: [{ message: "No commits between main and x" }] } },
      failure(403),
    ]) {
      const github = pullsFake([], () => response);
      await expectCode(
        ensurePullRequest(github.client, repo, request),
        "GITHUB_WRITE_REJECTED",
      );
    }
  });
});

/** A stateful Issue with comments and labels. */
function issueFake(
  comments: Array<ReturnType<typeof comment>>,
  labels: string[] = [],
  state = "open",
) {
  const model = { comments, labels, state, nextId: 100 };
  const outcomes: Record<string, Outcome> = {};
  const outcome = (key: string) => outcomes[key] ?? "ok";
  const github: FakeGitHub = fakeGitHub({
    "GET /repos/acme/app/issues/1": () => ({
      data: issue(1, { state: model.state as "open", labels: model.labels }),
    }),
    "PATCH /repos/acme/app/issues/1": (call) =>
      answer(outcome("close"), () => {
        model.state = (call.body as { state: string }).state;
        return { data: issue(1) };
      }),
    "GET /repos/acme/app/issues/1/comments": (call) => paged(model.comments)(call),
    "POST /repos/acme/app/issues/1/comments": (call) =>
      answer(outcome("create"), () => {
        const created = comment(
          model.nextId++,
          fakeActor.id,
          (call.body as { body: string }).body,
        );
        model.comments.push(created);
        return { status: 201, data: created };
      }),
    "GET /repos/acme/app/issues/1/labels": (call) =>
      paged(model.labels.map((name) => ({ name })))(call),
    "POST /repos/acme/app/issues/1/labels": (call) =>
      answer(outcome("add"), () => {
        for (const label of (call.body as { labels: string[] }).labels) {
          if (!model.labels.includes(label)) model.labels.push(label);
        }
        return { data: [] };
      }),
  });
  const commentRoute = (id: number) => `PATCH /repos/acme/app/issues/comments/${id}`;
  for (const existing of comments) {
    github.routes.set(commentRoute(existing.id), (call) =>
      answer(outcome("update"), () => {
        existing.body = (call.body as { body: string }).body;
        return { data: existing };
      }),
    );
  }
  for (const label of ["scope", "shaped", "delivered", "pause", "a", "b"]) {
    github.routes.set(`DELETE /repos/acme/app/issues/1/labels/${label}`, () =>
      answer(outcome(`remove ${label}`), () => {
        model.labels = model.labels.filter((name) => name !== label);
        return { data: [] };
      }),
    );
  }
  return { github, model, outcomes };
}

const marked = (body: string) => `${commentMarker("shape")}\n${body}`;

describe("marked comments", () => {
  it("validates comment keys", () => {
    assert.equal(commentMarker("shape-review"), "<!-- nibfin:shape-review -->");
    for (const key of ["", "Shape", "a -->", "-x"]) {
      assert.throws(() => commentMarker(key), TypeError);
    }
  });

  it("finds the actor's comments starting with the marker, oldest first", async () => {
    const { github } = issueFake([
      comment(5, 7, marked("someone else")),
      comment(9, fakeActor.id, marked("newer")),
      comment(6, fakeActor.id, `quote ${marked("x")}`),
      comment(8, fakeActor.id, marked("older")),
      comment(4, null, marked("ghost")),
      comment(3, fakeActor.id, null),
      comment(2, fakeActor.id, `${commentMarker("shape-review")}\nx`),
    ]);
    const found = await findMarkedComment(github.client, target, "shape");
    assert.deepEqual(found, {
      id: 8,
      body: marked("older"),
      url: "https://github.com/acme/app/issues/1#issuecomment-8",
    });
    const none = issueFake([comment(5, 7, marked("x"))]);
    assert.equal(await findMarkedComment(none.github.client, target, "shape"), undefined);
  });

  it("lists the comments of a pull request with REST", async () => {
    const github = fakeGitHub({
      "GET /repos/acme/app/issues/7/comments": paged([
        comment(3, null, marked("ghost")),
        comment(4, fakeActor.id, null),
        comment(5, fakeActor.id, marked("review")),
      ]),
    });
    const pr = { ...target, number: 7 };
    const found = await findMarkedComment(github.client, pr, "shape", "pull-request");
    assert.equal(found?.id, 5);
    assert.deepEqual(
      github.calls.map((call) => `${call.method} ${call.path}`),
      ["GET /repos/acme/app/issues/7/comments"],
    );
  });

  it("fails when the comments cannot be read", async () => {
    const github = fakeGitHub({
      "GET /repos/acme/app/issues/1": { data: issue(1) },
      "GET /repos/acme/app/issues/1/comments": failure(500),
    });
    await expectCode(
      findMarkedComment(github.client, target, "shape"),
      "GITHUB_READ_FAILED",
    );
  });

  it("creates the comment, never adopting another author's", async () => {
    const { github, model } = issueFake([comment(5, 7, marked("theirs"))]);
    const written = await upsertMarkedComment(github.client, target, "shape", "mine");
    assert.equal(written.body, marked("mine"));
    assert.equal(written.id, 100);
    assert.equal(model.comments[0]?.body, marked("theirs"));
  });

  it("updates the oldest marked comment in place and leaves the others", async () => {
    const { github, model } = issueFake([
      comment(8, fakeActor.id, marked("old")),
      comment(9, fakeActor.id, marked("duplicate")),
    ]);
    const written = await upsertMarkedComment(github.client, target, "shape", "new");
    assert.deepEqual([written.id, written.body], [8, marked("new")]);
    assert.equal(model.comments[1]?.body, marked("duplicate"));
    assert.deepEqual(
      github.writes().map((call) => `${call.method} ${call.path}`),
      ["PATCH /repos/acme/app/issues/comments/8"],
    );
  });

  it("does not write an unchanged body", async () => {
    const { github } = issueFake([comment(8, fakeActor.id, marked("same"))]);
    const written = await upsertMarkedComment(github.client, target, "shape", "same");
    assert.equal(written.id, 8);
    assert.deepEqual(github.writes(), []);
  });

  it("confirms an unknown outcome by re-reading", async () => {
    for (const key of ["create", "update"]) {
      const existing = key === "update" ? [comment(8, fakeActor.id, marked("old"))] : [];
      const { github, outcomes } = issueFake(existing);
      outcomes[key] = "applied-then-502";
      const written = await upsertMarkedComment(github.client, target, "shape", "new");
      assert.equal(written.body, marked("new"));
    }
  });

  it("reports unconfirmed when the re-read does not show the write", async () => {
    for (const key of ["create", "update"]) {
      const existing = key === "update" ? [comment(8, fakeActor.id, marked("old"))] : [];
      const { github, outcomes } = issueFake(existing);
      outcomes[key] = "lost";
      await expectCode(
        upsertMarkedComment(github.client, target, "shape", "new"),
        "GITHUB_WRITE_UNCONFIRMED",
      );
    }
  });

  it("rejects a client error and reports a comment gone after the write", async () => {
    const { github, outcomes } = issueFake([comment(8, fakeActor.id, marked("old"))]);
    outcomes.update = 404;
    await expectCode(
      upsertMarkedComment(github.client, target, "shape", "new"),
      "GITHUB_WRITE_REJECTED",
    );
    const gone = fakeGitHub({
      "GET /repos/acme/app/issues/1": { data: issue(1) },
      "GET /repos/acme/app/issues/1/comments": paged([]),
      "POST /repos/acme/app/issues/1/comments": {
        status: 201,
        data: comment(1, 42, "x"),
      },
    });
    await expectCode(
      upsertMarkedComment(gone.client, target, "shape", "new"),
      "GITHUB_WRITE_UNCONFIRMED",
    );
  });
});

describe("setLabels", () => {
  it("adds missing and removes present labels only", async () => {
    const { github, model } = issueFake([], ["scope", "pause"]);
    const labels = await setLabels(github.client, target, {
      add: ["scope", "shaped"],
      remove: ["pause", "delivered"],
    });
    assert.deepEqual(labels, ["scope", "shaped"]);
    assert.deepEqual(model.labels, ["scope", "shaped"]);
    assert.deepEqual(
      github.writes().map((call) => [call.method, call.path, call.body]),
      [
        ["POST", "/repos/acme/app/issues/1/labels", { labels: ["shaped"] }],
        ["DELETE", "/repos/acme/app/issues/1/labels/pause", undefined],
      ],
    );
  });

  it("writes nothing when the labels are already in place", async () => {
    const { github } = issueFake([], ["scope"]);
    assert.deepEqual(await setLabels(github.client, target, { add: ["scope"] }), [
      "scope",
    ]);
    assert.deepEqual(await setLabels(github.client, target, {}), ["scope"]);
    assert.deepEqual(github.writes(), []);
  });

  it("refuses a label that is both added and removed", async () => {
    const { github } = issueFake([]);
    await assert.rejects(
      setLabels(github.client, target, { add: ["a"], remove: ["a"] }),
      TypeError,
    );
  });

  it("treats a removal 404 as success when the label is absent", async () => {
    const { github, model } = issueFake([], ["a"]);
    // Removed concurrently between Nibfin's read and its DELETE.
    github.routes.set("DELETE /repos/acme/app/issues/1/labels/a", () => {
      model.labels = [];
      return failure(404, "Label does not exist");
    });
    assert.deepEqual(await setLabels(github.client, target, { remove: ["a"] }), []);
    const stuck = issueFake([], ["a"]);
    stuck.outcomes["remove a"] = 404;
    await expectCode(
      setLabels(stuck.github.client, target, { remove: ["a"] }),
      "GITHUB_WRITE_REJECTED",
    );
  });

  it("confirms or reports unknown add and remove outcomes", async () => {
    const added = issueFake([]);
    added.outcomes.add = "applied-then-502";
    assert.deepEqual(await setLabels(added.github.client, target, { add: ["a"] }), ["a"]);
    const lostAdd = issueFake([]);
    lostAdd.outcomes.add = "lost";
    await expectCode(
      setLabels(lostAdd.github.client, target, { add: ["a"] }),
      "GITHUB_WRITE_UNCONFIRMED",
    );
    const removed = issueFake([], ["a"]);
    removed.outcomes["remove a"] = "applied-then-502";
    assert.deepEqual(
      await setLabels(removed.github.client, target, { remove: ["a"] }),
      [],
    );
    const lostRemove = issueFake([], ["a"]);
    lostRemove.outcomes["remove a"] = "lost";
    await expectCode(
      setLabels(lostRemove.github.client, target, { remove: ["a"] }),
      "GITHUB_WRITE_UNCONFIRMED",
    );
  });

  it("rejects other client errors and fails on unreadable labels", async () => {
    const forbidden = issueFake([], ["a"]);
    forbidden.outcomes.add = 403;
    forbidden.outcomes["remove a"] = 403;
    await expectCode(
      setLabels(forbidden.github.client, target, { add: ["b"] }),
      "GITHUB_WRITE_REJECTED",
    );
    await expectCode(
      setLabels(forbidden.github.client, target, { remove: ["a"] }),
      "GITHUB_WRITE_REJECTED",
    );
    const unreadable = fakeGitHub({ "GET /repos/acme/app/issues/1": networkError() });
    await expectCode(
      setLabels(unreadable.client, target, { add: ["a"] }),
      "GITHUB_READ_FAILED",
    );
  });
});

describe("closeDelivered", () => {
  it("adds delivered, then closes as completed", async () => {
    const { github, model } = issueFake([], ["scope", "shaped"]);
    await closeDelivered(github.client, target);
    assert.deepEqual(model.labels, ["scope", "shaped", "delivered"]);
    assert.equal(model.state, "closed");
    const writes = github.writes();
    assert.equal(writes[0]?.path, "/repos/acme/app/issues/1/labels");
    assert.deepEqual(writes[1]?.body, { state: "closed", state_reason: "completed" });
  });

  it("finishes the close of an open Issue that already has delivered", async () => {
    const { github, model } = issueFake([], ["delivered"]);
    await closeDelivered(github.client, target);
    assert.equal(model.state, "closed");
    assert.deepEqual(
      github.writes().map((call) => call.method),
      ["PATCH"],
    );
  });

  it("writes nothing when the Issue is already closed with delivered", async () => {
    const { github } = issueFake([], ["delivered"], "closed");
    await closeDelivered(github.client, target);
    assert.deepEqual(github.writes(), []);
  });

  it("confirms, reports or rejects the close", async () => {
    const applied = issueFake([], ["delivered"]);
    applied.outcomes.close = "applied-then-502";
    await closeDelivered(applied.github.client, target);
    assert.equal(applied.model.state, "closed");
    const lost = issueFake([], ["delivered"]);
    lost.outcomes.close = "lost";
    await expectCode(
      closeDelivered(lost.github.client, target),
      "GITHUB_WRITE_UNCONFIRMED",
    );
    const forbidden = issueFake([], ["delivered"]);
    forbidden.outcomes.close = 403;
    await expectCode(
      closeDelivered(forbidden.github.client, target),
      "GITHUB_WRITE_REJECTED",
    );
  });
});

describe("closeIssueAs", () => {
  it("closes as not planned without touching the labels", async () => {
    const { github, model } = issueFake([], ["request"]);
    await closeIssueAs(github.client, target, "not_planned");
    assert.equal(model.state, "closed");
    assert.deepEqual(model.labels, ["request"]);
    assert.deepEqual(
      github.writes().map((call) => call.body),
      [{ state: "closed", state_reason: "not_planned" }],
    );
  });

  it("writes nothing for a closed Issue", async () => {
    const { github } = issueFake([], ["request"], "closed");
    await closeIssueAs(github.client, target, "not_planned");
    assert.deepEqual(github.writes(), []);
  });
});

describe("deleteBranch", () => {
  const refPath = `/repos/acme/app/git/ref/heads/${branch}`;

  /**
   * A branch ref answering the DELETE with `outcome`; `gone` removes the ref on any
   * answer (deleted concurrently), and `read` replaces the re-read of the ref.
   */
  function refFake(outcome: Outcome, options: { gone?: boolean; read?: Route } = {}) {
    const model = { exists: true };
    const github = fakeGitHub({
      [`DELETE /repos/acme/app/git/refs/heads/${branch}`]: () => {
        if (options.gone) {
          model.exists = false;
        }
        return answer(outcome, () => {
          model.exists = false;
          return { status: 204 };
        });
      },
      [`GET ${refPath}`]:
        options.read ??
        (() => (model.exists ? { data: { ref: `refs/heads/${branch}` } } : failure(404))),
    });
    return { github, model };
  }

  it("deletes the branch ref", async () => {
    const { github, model } = refFake("ok");
    await deleteBranch(github.client, repo, branch);
    assert.equal(model.exists, false);
    assert.deepEqual(
      github.calls.map((call) => `${call.method} ${call.path}`),
      [`DELETE /repos/acme/app/git/refs/heads/${branch}`],
    );
  });

  it("treats a 4xx as done when the ref is gone", async () => {
    const { github } = refFake(422, { gone: true });
    await deleteBranch(github.client, repo, branch);
    assert.equal(github.calls.at(-1)?.path, refPath);
  });

  it("rejects a 4xx while the ref is present or unreadable", async () => {
    const present = refFake(422);
    await expectCode(
      deleteBranch(present.github.client, repo, branch),
      "GITHUB_WRITE_REJECTED",
    );
    const unreadable = refFake(409, { gone: true, read: failure(500) });
    const error = await expectCode(
      deleteBranch(unreadable.github.client, repo, branch),
      "GITHUB_WRITE_REJECTED",
    );
    assert.equal((error.cause as { status: number }).status, 409);
  });

  it("confirms an unknown outcome by re-reading the ref", async () => {
    const applied = refFake("applied-then-502");
    await deleteBranch(applied.github.client, repo, branch);
    assert.equal(applied.model.exists, false);
    const lost = refFake("lost");
    await expectCode(
      deleteBranch(lost.github.client, repo, branch),
      "GITHUB_WRITE_UNCONFIRMED",
    );
    assert.equal(lost.model.exists, true);
  });
});

describe("retries of writes", () => {
  const closePath = "/repos/acme/app/issues/1";
  const closeLine = (k: number, cause: string, seconds: number) =>
    `GitHub PATCH ${closePath} (retry ${k} of 3): ${cause}; waiting ${seconds} s`;

  /** An Issue with `delivered` whose close answers `answers` in turn, then applies. */
  function closing(...answers: Outcome[]) {
    const { github, model } = issueFake([], ["delivered"]);
    github.routes.set(`PATCH ${closePath}`, () =>
      answer(answers.shift() ?? "ok", () => {
        model.state = "closed";
        return { data: issue(1) };
      }),
    );
    return { github, model };
  }

  it("re-sends a write after any 4xx and succeeds on the third retry", async () => {
    const { github, model } = closing(422, 403, "lost");
    await closeDelivered(github.client, target);
    assert.equal(model.state, "closed");
    assert.equal(github.writes().length, 4);
    assert.deepEqual(github.waits, [1, 4, 9]);
    assert.deepEqual(github.log, [
      closeLine(1, "HTTP 422", 1),
      closeLine(2, "HTTP 403", 4),
      closeLine(3, "no response", 9),
    ]);
  });

  it("fails as before after the third retry", async () => {
    const rejected = closing(422, 422, 422, 422);
    await expectCode(
      closeDelivered(rejected.github.client, target),
      "GITHUB_WRITE_REJECTED",
    );
    assert.equal(rejected.github.writes().length, 4);
    assert.equal(
      rejected.github.log.at(-1),
      `GitHub PATCH ${closePath}: HTTP 422; not retrying after 3 retries`,
    );
    const lost = closing("lost", "lost", "lost", "lost");
    await expectCode(
      closeDelivered(lost.github.client, target),
      "GITHUB_WRITE_UNCONFIRMED",
    );
    assert.equal(lost.github.writes().length, 4);
    assert.equal(lost.model.state, "open");
  });

  it("does not re-send a write whose unknown outcome took effect", async () => {
    const { github, model } = issueFake([]);
    const create = "POST /repos/acme/app/issues/1/comments";
    const post = github.routes.get(create) as (call: FakeRequest) => FakeResponse;
    let sent = 0;
    github.routes.set(create, (call) => {
      sent += 1;
      // The first attempt is applied but answers 502; GitHub must not get a second.
      post(call);
      return failure(502);
    });
    const written = await upsertMarkedComment(github.client, target, "shape", "new");
    assert.equal(written.body, marked("new"));
    assert.equal(sent, 1);
    assert.equal(model.comments.length, 1);
    assert.deepEqual(github.waits, [1]);
  });

  it("re-reads before each re-send and skips it once the write is in place", async () => {
    const { github, model } = issueFake([]);
    const add = "POST /repos/acme/app/issues/1/labels";
    let sent = 0;
    github.routes.set(add, () => {
      sent += 1;
      if (sent === 2) {
        // Applied by GitHub after the second answer was lost.
        model.labels.push("scope");
        throw new TypeError("fetch failed");
      }
      return failure(500);
    });
    assert.deepEqual(await setLabels(github.client, target, { add: ["scope"] }), [
      "scope",
    ]);
    assert.equal(sent, 2);
  });

  it("does not re-send when the pre-read fails", async () => {
    for (const [status, code] of [
      [503, "GITHUB_WRITE_UNCONFIRMED"],
      [403, "GITHUB_WRITE_REJECTED"],
    ] as const) {
      let reads = 0;
      const github = fakeGitHub({
        "GET /repos/acme/app/pulls": () => (++reads === 1 ? { data: [] } : failure(500)),
        "POST /repos/acme/app/pulls": failure(status),
      });
      const request = { branch, base: "main", title: "T", body: "B" };
      const error = await expectCode(
        ensurePullRequest(github.client, repo, request),
        code,
      );
      assert.equal((error.cause as { status: number }).status, status);
      assert.equal(github.writes().length, 1);
    }
  });

  it("does not retry a 4xx that already means success", async () => {
    const { github, model } = issueFake([], ["scope"]);
    github.routes.set("DELETE /repos/acme/app/issues/1/labels/scope", () => {
      model.labels = [];
      return failure(404);
    });
    await setLabels(github.client, target, { remove: ["scope"] });
    assert.equal(github.writes().length, 1);
    assert.deepEqual(github.waits, []);
  });
});

describe("the last retry of a write", () => {
  it("re-reads an unknown outcome once more before it is unconfirmed", async () => {
    const issueFakeClose = (...answers: Outcome[]) => {
      const { github, model } = issueFake([], ["delivered"]);
      github.routes.set("PATCH /repos/acme/app/issues/1", () =>
        answer(answers.shift() ?? "ok", () => {
          model.state = "closed";
          return { data: issue(1) };
        }),
      );
      return { github, model };
    };
    const landed = issueFakeClose("lost", "lost", "lost", "applied-then-502");
    await closeDelivered(landed.github.client, target);
    assert.equal(landed.model.state, "closed");
    assert.equal(landed.github.writes().length, 4);
    assert.deepEqual(landed.github.log.slice(3), []);
    let reads = 0;
    const unreadable = fakeGitHub({
      // The first read and the three pre-reads find no PR; the last re-read fails.
      "GET /repos/acme/app/pulls": () => (++reads <= 4 ? { data: [] } : failure(500)),
      "POST /repos/acme/app/pulls": networkError(),
    });
    const request = { branch, base: "main", title: "T", body: "B" };
    await expectCode(
      ensurePullRequest(unreadable.client, repo, request),
      "GITHUB_WRITE_UNCONFIRMED",
    );
    assert.equal(unreadable.writes().length, 4);
  });
});
