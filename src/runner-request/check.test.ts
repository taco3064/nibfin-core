import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  checkKey,
  checkRequest,
  keyType,
  permissionRefusal,
  type RequestIssue,
  requestMarker,
} from "./check.ts";
import { ed25519Blob, requestIssue } from "./fake-request.test.ts";

const repo = { owner: "acme", repo: "app" };
const openAgain = "Open the request with gh nibfin runner add.";

function refusalOf(issue: RequestIssue) {
  const check = checkRequest(issue, repo);
  assert.ok(check.kind === "refused");
  return check.refusal;
}

describe("checkRequest", () => {
  it("passes a request with one key id and no deploy key", () => {
    assert.deepEqual(checkRequest(requestIssue(), repo), {
      kind: "ok",
      keyId: "12345",
      deployKey: undefined,
    });
  });

  it("passes an ssh-ed25519 deploy key, carriage returns removed", () => {
    const blob = ed25519Blob();
    const body =
      `${requestMarker}\r\nssh-key-id: 9\r\n` + `deploy-key: ssh-ed25519 ${blob}\r\n`;
    assert.deepEqual(checkRequest(requestIssue({ body }), repo), {
      kind: "ok",
      keyId: "9",
      deployKey: `ssh-ed25519 ${blob}`,
    });
  });

  it("takes the largest key id of 19 digits", () => {
    const body = `ssh-key-id: 1${"0".repeat(18)}`;
    const check = checkRequest(requestIssue({ body }), repo);
    assert.equal(check.kind === "ok" && check.keyId, `1${"0".repeat(18)}`);
  });

  it("refuses another title", () => {
    assert.deepEqual(refusalOf(requestIssue({ title: "Runner" })), {
      reason: 'the title is not "Nibfin runner request"',
      next: openAgain,
    });
  });

  it("refuses an author that is not a user", () => {
    assert.deepEqual(refusalOf(requestIssue({ userType: "Bot" })), {
      reason: "the author ann is a Bot account, not a user",
      next:
        "A user with write access to acme/app opens the request with " +
        "gh nibfin runner add.",
    });
  });

  for (const [name, body, count] of [
    ["no key id line", "hello", 0],
    ["two key id lines", "ssh-key-id: 1\nssh-key-id: 2", 2],
  ] as const) {
    it(`refuses ${name}`, () => {
      assert.deepEqual(refusalOf(requestIssue({ body })), {
        reason: `the body has ${count} ssh-key-id lines, want exactly one`,
        next: openAgain,
      });
    });
  }

  for (const line of [
    "ssh-key-id: 0",
    "ssh-key-id: 012",
    "ssh-key-id: 12 ",
    "ssh-key-id:12",
    `ssh-key-id: 1${"0".repeat(19)}`,
  ]) {
    it(`refuses the key id line ${JSON.stringify(line)}`, () => {
      assert.deepEqual(refusalOf(requestIssue({ body: line })), {
        reason: 'the ssh-key-id line is not "ssh-key-id: <id>"',
        next: openAgain,
      });
    });
  }

  it("refuses two deploy key lines", () => {
    const line = `deploy-key: ssh-ed25519 ${ed25519Blob()}`;
    const body = `ssh-key-id: 1\n${line}\n${line}`;
    assert.deepEqual(refusalOf(requestIssue({ body })), {
      reason: "the body has 2 deploy-key lines, want at most one",
      next: openAgain,
    });
  });

  const wrongKeys: [string, string][] = [
    ["another key type", `ssh-rsa ${ed25519Blob()}`],
    ["a trailing comment", `ssh-ed25519 ${ed25519Blob()} me`],
    ["a stray base64 character", `ssh-ed25519 ${ed25519Blob()}A`],
    ["too few key bytes", `ssh-ed25519 ${Buffer.alloc(48, 1).toString("base64")}`],
    [
      "another wire name",
      `ssh-ed25519 ${Buffer.concat([
        Buffer.from("0000000b7373682d6564323535313800000020", "hex"),
        Buffer.alloc(32, 1),
      ]).toString("base64")}`,
    ],
  ];
  for (const [name, key] of wrongKeys) {
    it(`refuses a deploy key with ${name}`, () => {
      const body = `ssh-key-id: 1\ndeploy-key: ${key}`;
      assert.deepEqual(refusalOf(requestIssue({ body })), {
        reason: "the deploy-key line is not an ssh-ed25519 public key",
        next: openAgain,
      });
    });
  }
});

describe("permissionRefusal", () => {
  it("names the author's permission", () => {
    assert.deepEqual(permissionRefusal("ann", "read", repo), {
      reason: "ann has read permission on acme/app, not write or admin",
      next:
        "Ask the owner of acme/app to make you a collaborator with write access, " +
        "then run gh nibfin runner add again.",
    });
  });
});

describe("checkKey", () => {
  it("takes an ssh-ed25519 or ssh-rsa key", () => {
    assert.equal(checkKey("ann", "5", "ssh-ed25519 AAAA"), undefined);
    assert.equal(checkKey("ann", "5", "ssh-rsa AAAA"), undefined);
  });

  it("refuses a key id the account does not have", () => {
    const refusal = {
      reason: "ann has no SSH key with id 5 on GitHub",
      next:
        "Add the SSH key to your GitHub account, then run gh nibfin runner add " +
        "again.",
    };
    assert.deepEqual(checkKey("ann", "5", undefined), refusal);
    assert.deepEqual(checkKey("ann", "5", ""), refusal);
  });

  it("refuses another key type", () => {
    assert.deepEqual(checkKey("ann", "5", "ecdsa-sha2-nistp256 AAAA"), {
      reason: "the SSH key 5 of ann is ecdsa-sha2-nistp256, not ssh-ed25519 or ssh-rsa",
      next:
        "Use an ssh-ed25519 or ssh-rsa key of your GitHub account with " +
        "gh nibfin runner add.",
    });
  });
});

describe("keyType", () => {
  it("is the text before the first space", () => {
    assert.equal(keyType("ssh-rsa AAAA x"), "ssh-rsa");
    assert.equal(keyType("ssh-rsa"), "ssh-rsa");
  });
});
