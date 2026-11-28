import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  failure,
  fakeGitHub,
  type Handler,
  paged,
  rejection,
} from "../github/fake-github.test.ts";
import { fakeIssue, fakeIssues, seedComment } from "../stages/fake-job.test.ts";
import { type Age, AgeError } from "./age.ts";
import { answerRequest, type RunnerRequestDeps } from "./answer.ts";
import { requestMarker } from "./check.ts";
import { ed25519Blob, requestIssue } from "./fake-request.test.ts";

const repo = { owner: "acme", repo: "app" };
const url = "https://github.com/acme/app/actions/runs/900";
const sshKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIA";
const registration = "POST /repos/acme/app/actions/runners/registration-token";
const regToken = "REGISTRATION-TOKEN-SECRET";

/** A fake `age` that records its calls; its ciphertext names the plaintext length. */
function fakeAge(fails = false) {
  const calls: string[] = [];
  const age: Age = {
    check: () => {
      calls.push("check");
      return fails
        ? Promise.reject(new AgeError("age --version", "ENOENT"))
        : Promise.resolve();
    },
    encrypt: (recipient, plaintext) => {
      calls.push(`encrypt ${recipient} ${plaintext.length}`);
      return Promise.resolve(
        "-----BEGIN AGE ENCRYPTED FILE-----\nCIPHER\n-----END AGE ENCRYPTED FILE-----\n",
      );
    },
  };
  return { age, calls };
}

/**
 * acme/app#1 behind the job token's fake (REST Issue, comments, close) and the
 * Nibfin token's fake (permission, deploy keys, registration token).
 */
function world(permission: string | null = "write", age = fakeAge()) {
  const issues = fakeIssues(fakeIssue({ labels: [] }));
  const job = issues.github;
  job.routes.set("PATCH /repos/acme/app/issues/1", (request) => {
    issues.main.state = (request.body as { state: "closed" }).state;
    return { data: { number: 1, state: issues.main.state } };
  });
  job.routes.set("GET /users/ann/keys", paged([{ id: 12345, key: sshKey }]));
  const nibfin = fakeGitHub({
    [registration]: {
      status: 201,
      data: { token: regToken, expires_at: "2026-11-28T01:00:00Z" },
    },
    "POST /repos/acme/app/keys": { status: 201, data: { id: 3, read_only: true } },
  });
  if (permission !== null) {
    nibfin.routes.set("GET /repos/acme/app/collaborators/ann/permission", {
      data: { permission },
    });
  }
  const log: string[] = [];
  let connects = 0;
  const deps: RunnerRequestDeps = {
    job: job.client,
    connect: () => {
      connects += 1;
      return Promise.resolve(nibfin.client);
    },
    age: age.age,
    log: (line) => void log.push(line),
  };
  return { issues, job, nibfin, deps, log, age, connects: () => connects };
}

type World = ReturnType<typeof world>;

const answer = (w: World, issue = requestIssue()) =>
  answerRequest({ repo, issue, url }, w.deps);

const refused = (reason: string, next: string) =>
  `<!-- nibfin:runner-request-refused -->\nreason: ${reason}\n\n${next}\n`;

const failedBody = refused(
  `the request workflow failed (${url})`,
  "Read the run's log; run gh nibfin runner add again when the cause is fixed.",
);

function assertNoToken(w: World) {
  const written = w.job.writes().map((call) => JSON.stringify(call.body));
  for (const text of [...w.log.filter((line) => !line.startsWith("::")), ...written]) {
    assert.ok(!text.includes(regToken), text);
  }
}

describe("answerRequest registration", () => {
  it("answers with the token encrypted to the key, the Issue open", async () => {
    const w = world();
    assert.equal(await answer(w), "answered");
    const [comment] = w.issues.marked("runner-registration");
    assert.equal(
      comment.body,
      [
        "<!-- nibfin:runner-registration -->",
        "requester: ann",
        "ssh-key-id: 12345",
        "expires-at: 2026-11-28T01:00:00Z",
        "",
        "A runner registration token for acme/app, encrypted to the SSH key 12345 of " +
          "@ann. gh nibfin runner add decrypts it and registers the runner.",
        "",
        "```text",
        "-----BEGIN AGE ENCRYPTED FILE-----",
        "CIPHER",
        "-----END AGE ENCRYPTED FILE-----",
        "```",
        "",
      ].join("\n"),
    );
    assert.equal(w.issues.main.state, "open");
    assert.deepEqual(w.age.calls, ["check", `encrypt ${sshKey} ${regToken.length}`]);
    assertNoToken(w);
    const mask = w.log.indexOf(`::add-mask::${regToken}`);
    assert.ok(mask >= 0);
    assert.deepEqual(w.log.slice(0, mask), [
      "Request of ann for the SSH key 12345 (ssh-ed25519)",
    ]);
    assert.match(w.log.at(-1)!, /^Answered acme\/app#1: https:\/\/github\.com\/\S+$/);
    // The Nibfin token's client only reads the permission and creates the token.
    assert.deepEqual(
      w.nibfin.calls.map((call) => `${call.method} ${call.path}`),
      ["GET /repos/acme/app/collaborators/ann/permission", registration],
    );
    assert.ok(w.job.calls.every((call) => call.path !== "/graphql"));
  });

  it("adds the deploy key before the token", async () => {
    const w = world();
    const deployKey = `ssh-ed25519 ${ed25519Blob()}`;
    const body = `${requestMarker}\nssh-key-id: 12345\ndeploy-key: ${deployKey}\n`;
    assert.equal(await answer(w, requestIssue({ body })), "answered");
    assert.deepEqual(
      w.nibfin.writes().map((call) => [call.path, call.body]),
      [
        [
          "/repos/acme/app/keys",
          { title: "nibfin-runner-ann", key: deployKey, read_only: true },
        ],
        ["/repos/acme/app/actions/runners/registration-token", undefined],
      ],
    );
    assert.ok(w.log.includes("The request has a deploy key"));
    assert.ok(
      w.log.includes(
        "Added the read-only deploy key nibfin-runner-ann to acme/app (id 3)",
      ),
    );
  });

  it("takes a deploy key the repository already has", async () => {
    const w = world();
    const deployKey = `ssh-ed25519 ${ed25519Blob()}`;
    w.nibfin.routes.set("POST /repos/acme/app/keys", failure(422));
    w.nibfin.routes.set(
      "GET /repos/acme/app/keys",
      paged([{ id: 8, key: deployKey, read_only: true }]),
    );
    const body = `${requestMarker}\nssh-key-id: 12345\ndeploy-key: ${deployKey}\n`;
    assert.equal(await answer(w, requestIssue({ body })), "answered");
    assert.ok(
      w.log.includes(
        "The key is already a deploy key of acme/app (id 8, read_only true)",
      ),
    );
  });

  it("updates its own earlier answer on a re-run", async () => {
    const w = world();
    const earlier = seedComment(
      w.issues,
      w.issues.main,
      "<!-- nibfin:runner-registration -->\nold",
    );
    await answer(w);
    assert.equal(w.issues.marked("runner-registration").length, 1);
    assert.ok(earlier.body.startsWith("<!-- nibfin:runner-registration -->\nrequester:"));
  });
});

describe("answerRequest without an answer", () => {
  it("leaves a body without the request marker before any call", async () => {
    const w = world();
    const issue = requestIssue({ body: "ssh-key-id: 1" });
    assert.equal(await answer(w, issue), "not-a-request");
    assert.deepEqual(w.log, ["acme/app#1 is not a runner request; nothing to answer"]);
    assert.deepEqual(w.job.calls, []);
  });

  it("does not answer a request that is no longer open", async () => {
    const w = world();
    w.issues.main.state = "closed";
    assert.equal(await answer(w), "not-open");
    assert.deepEqual(w.log, ["acme/app#1 is closed; nothing to answer"]);
    assert.deepEqual(w.job.writes(), []);
    assert.equal(w.connects(), 0);
  });
});

describe("answerRequest refusals", () => {
  async function expectRefusal(w: World, body: string, issue = requestIssue()) {
    assert.equal(await answer(w, issue), "refused");
    assert.equal(w.issues.marked("runner-request-refused")[0].body, body);
    assert.equal(w.issues.main.state, "closed");
    assert.deepEqual(w.nibfin.writes(), []);
    assert.deepEqual(w.age.calls, []);
  }

  it("refuses a failed body check without the Nibfin token", async () => {
    const w = world();
    const body = refused(
      'the title is not "Nibfin runner request"',
      "Open the request with gh nibfin runner add.",
    );
    await expectRefusal(w, body, requestIssue({ title: "Runner" }));
    assert.equal(w.connects(), 0);
    assert.ok(w.log.includes('Refused: the title is not "Nibfin runner request"'));
    assert.ok(w.log.includes("Closed acme/app#1 as not planned"));
  });

  for (const [permission, shown] of [
    ["read", "read"],
    [null, "none"],
  ] as const) {
    it(`refuses an author with ${shown} permission`, async () => {
      const w = world(permission);
      const body = refused(
        `ann has ${shown} permission on acme/app, not write or admin`,
        "Ask the owner of acme/app to make you a collaborator with write access, " +
          "then run gh nibfin runner add again.",
      );
      await expectRefusal(w, body);
    });
  }

  it("refuses a key id the author does not have", async () => {
    const w = world("admin");
    w.job.routes.set("GET /users/ann/keys", paged([{ id: 1, key: sshKey }]));
    await expectRefusal(
      w,
      refused(
        "ann has no SSH key with id 12345 on GitHub",
        "Add the SSH key to your GitHub account, then run gh nibfin runner add again.",
      ),
    );
  });

  it("refuses a key of another type", async () => {
    const w = world();
    w.job.routes.set(
      "GET /users/ann/keys",
      paged([{ id: 12345, key: "ecdsa-sha2-nistp256 AAAA" }]),
    );
    await expectRefusal(
      w,
      refused(
        "the SSH key 12345 of ann is ecdsa-sha2-nistp256, not ssh-ed25519 or ssh-rsa",
        "Use an ssh-ed25519 or ssh-rsa key of your GitHub account with " +
          "gh nibfin runner add.",
      ),
    );
  });
});

describe("answerRequest failures", () => {
  async function expectFailed(w: World, issue = requestIssue()) {
    const error = await rejection(answer(w, issue));
    assert.equal(w.issues.marked("runner-request-refused")[0].body, failedBody);
    assert.equal(w.issues.main.state, "closed");
    assertNoToken(w);
    return error;
  }

  it("answers as failed without any write when age does not run", async () => {
    const w = world("write", fakeAge(true));
    const deployKey = `ssh-ed25519 ${ed25519Blob()}`;
    const body = `${requestMarker}\nssh-key-id: 12345\ndeploy-key: ${deployKey}\n`;
    const error = await expectFailed(w, requestIssue({ body }));
    assert.ok(error instanceof AgeError);
    assert.deepEqual(w.nibfin.writes(), []);
    assert.ok(
      w.log.includes(
        "The request failed: RUNNER_AGE_FAILED: age --version failed (ENOENT)",
      ),
    );
  });

  it("answers as failed when the token cannot be created", async () => {
    const w = world();
    w.nibfin.routes.set(registration, failure(500));
    const error = await expectFailed(w);
    assert.equal((error as { code?: string }).code, "GITHUB_WRITE_UNCONFIRMED");
    assert.deepEqual(w.age.calls, ["check"]);
  });

  it("answers as failed when GitHub returns no token", async () => {
    const w = world();
    w.nibfin.routes.set(registration, {
      status: 201,
      data: { token: "", expires_at: "" },
    });
    const error = await expectFailed(w);
    assert.equal((error as Error).message, "GitHub returned no registration token");
  });

  it("answers as failed when the Nibfin token cannot connect", async () => {
    const w = world();
    w.deps.connect = () => Promise.reject(new Error("INPUT_TOKEN is missing"));
    await expectFailed(w);
  });

  it("answers as failed when the state cannot be read", async () => {
    const w = world();
    let reads = 0;
    const path = "GET /repos/acme/app/issues/1";
    const state = w.job.routes.get(path) as Handler;
    w.job.routes.set(path, (request) => (++reads <= 4 ? failure(500) : state(request)));
    await expectFailed(w);
  });

  it("throws the answer's own failure when the answer cannot be written", async () => {
    const w = world();
    w.nibfin.routes.set(registration, failure(422));
    w.job.routes.set("POST /repos/acme/app/issues/1/comments", failure(422));
    const error = await rejection(answer(w));
    assert.equal((error as { code?: string }).code, "GITHUB_WRITE_REJECTED");
    assert.ok(
      w.log.some((line) => line.startsWith("The request failed: GITHUB_WRITE_REJECTED")),
    );
    assert.equal(w.issues.main.state, "open");
  });
});
