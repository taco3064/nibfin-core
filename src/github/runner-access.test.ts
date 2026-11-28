import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GitHubError } from "./errors.ts";
import {
  failure,
  fakeGitHub,
  paged,
  rejection,
  repo,
  sequence,
} from "./fake-github.test.ts";
import { addDeployKey, createRegistrationToken, readUserKeys } from "./runner-access.ts";

const key = "ssh-ed25519 AAAAblob";

describe("readUserKeys", () => {
  it("reads every page of the account's SSH keys", async () => {
    const keys = Array.from({ length: 101 }, (_, index) => ({
      id: index + 1,
      key: `ssh-rsa k${index + 1}`,
    }));
    const github = fakeGitHub({ "GET /users/ann/keys": paged(keys) });
    const read = await readUserKeys(github.client, "ann");
    assert.equal(read.length, 101);
    assert.deepEqual(read[100], { id: 101, key: "ssh-rsa k101" });
  });

  it("fails as a read when the keys cannot be read", async () => {
    const error = await rejection(readUserKeys(fakeGitHub().client, "ann"));
    assert.ok(error instanceof GitHubError);
    assert.equal(error.code, "GITHUB_READ_FAILED");
  });
});

describe("addDeployKey", () => {
  const keysPath = "/repos/acme/app/keys";

  it("adds the key read-only with its title", async () => {
    const github = fakeGitHub({
      [`POST ${keysPath}`]: { status: 201, data: { id: 3, read_only: true } },
    });
    const added = await addDeployKey(github.client, repo, "nibfin-runner-ann", key);
    assert.deepEqual(added, { id: 3, readOnly: true, added: true });
    assert.deepEqual(github.writes()[0].body, {
      title: "nibfin-runner-ann",
      key,
      read_only: true,
    });
  });

  it("takes a key that is already a deploy key of the repository", async () => {
    const github = fakeGitHub({
      [`POST ${keysPath}`]: failure(422, "key is already in use"),
      [`GET ${keysPath}`]: paged([
        { id: 1, key: "ssh-ed25519 other", read_only: true },
        { id: 2, key: `${key} comment`, read_only: false },
      ]),
    });
    const found = await addDeployKey(github.client, repo, "nibfin-runner-ann", key);
    assert.deepEqual(found, { id: 2, readOnly: false, added: false });
    assert.equal(github.writes().length, 1);
  });

  it("re-sends after a failure when the key is not there", async () => {
    const github = fakeGitHub({
      [`POST ${keysPath}`]: sequence(failure(500), {
        status: 201,
        data: { id: 4, read_only: true },
      }),
      [`GET ${keysPath}`]: paged([]),
    });
    const added = await addDeployKey(github.client, repo, "t", key);
    assert.equal(added.id, 4);
    assert.equal(github.writes().length, 2);
  });

  it("fails as rejected when the key cannot be added", async () => {
    const github = fakeGitHub({
      [`POST ${keysPath}`]: failure(422),
      [`GET ${keysPath}`]: paged([]),
    });
    const error = await rejection(addDeployKey(github.client, repo, "t", key));
    assert.ok(error instanceof GitHubError);
    assert.equal(error.code, "GITHUB_WRITE_REJECTED");
  });
});

describe("createRegistrationToken", () => {
  const path = "POST /repos/acme/app/actions/runners/registration-token";

  it("returns the token and when it expires", async () => {
    const github = fakeGitHub({
      [path]: { status: 201, data: { token: "REG", expires_at: "2026-11-28T01:00:00Z" } },
    });
    assert.deepEqual(await createRegistrationToken(github.client, repo), {
      token: "REG",
      expiresAt: "2026-11-28T01:00:00Z",
    });
  });

  it("re-sends without a pre-read up to three times", async () => {
    const github = fakeGitHub({ [path]: failure(500) });
    const error = await rejection(createRegistrationToken(github.client, repo));
    assert.ok(error instanceof GitHubError);
    assert.equal(error.code, "GITHUB_WRITE_UNCONFIRMED");
    assert.equal(github.writes().length, 4);
    assert.equal(github.calls.length, 4);
  });
});
