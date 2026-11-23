import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fakeActor, fakeToken, rejection } from "../github/fake-github.test.ts";
import { StageError } from "./errors.ts";
import {
  commitFile,
  fixtureGit,
  git,
  makeGitFixture,
  recordingGit,
} from "./fake-git.test.ts";
import {
  checkedOutBranch,
  commitsAhead,
  diffAgainstBase,
  Git,
  gitFailed,
  githubRemoteUrl,
  messagesAhead,
  prepareBranch,
  readBranchHead,
  refDirectory,
  refFormat,
} from "./git.ts";

const basic = Buffer.from(`x-access-token:${fakeToken}`).toString("base64");

describe("Git", () => {
  it("names the GitHub remote of a repository", () => {
    assert.equal(
      githubRemoteUrl({ owner: "acme", repo: "app" }),
      "https://github.com/acme/app.git",
    );
  });

  it("gives the header only to remote calls, through the environment", async () => {
    const fixture = await makeGitFixture("git-");
    const recorder = recordingGit();
    const subject = fixtureGit(fixture, recorder.run);
    await subject.run(["status"]);
    await subject.remote(["ls-remote", fixture.remote]);
    const [local, remote] = recorder.calls;
    assert.equal(local!.env.GIT_CONFIG_COUNT, undefined);
    assert.equal(local!.env.GIT_TERMINAL_PROMPT, "0");
    assert.equal(remote!.env.GIT_CONFIG_COUNT, "1");
    assert.equal(remote!.env.GIT_CONFIG_KEY_0, "http.https://github.com/.extraheader");
    assert.equal(remote!.env.GIT_CONFIG_VALUE_0, `AUTHORIZATION: basic ${basic}`);
    assert.equal(remote!.env.GIT_ALLOW_PROTOCOL, "file");
    assert.equal(remote!.env.GIT_ASKPASS, "");
    assert.deepEqual(remote!.args.slice(0, 6), [
      "-c",
      `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
      "-c",
      "credential.helper=",
      "-c",
      "push.gpgSign=false",
    ]);
    for (const call of recorder.calls) {
      assert.ok(!JSON.stringify(call.args).includes(fakeToken));
      assert.ok(!JSON.stringify(call.args).includes(basic));
    }
    const config = readFileSync(join(fixture.workspace, ".git", "config"), "utf8");
    assert.ok(!config.includes(fakeToken) && !config.includes(basic));
  });

  it("allows only https for a GitHub remote", async () => {
    const recorder = recordingGit(() => ({ exitCode: 0, stdout: "", stderr: "" }));
    const subject = new Git({
      workspace: resolve("/w"),
      remoteUrl: "https://github.com/acme/app.git",
      token: fakeToken,
      run: recorder.run,
    });
    await subject.remoteRequired(["ls-remote"]);
    assert.equal(recorder.calls[0]!.env.GIT_ALLOW_PROTOCOL, "https");
  });

  it("redacts the token and its header from Git output", async () => {
    const leak = `fatal: ${fakeToken} and ${basic}`;
    const recorder = recordingGit(() => ({ exitCode: 128, stdout: leak, stderr: leak }));
    const subject = new Git({
      workspace: resolve("/w"),
      remoteUrl: "x",
      token: fakeToken,
      run: recorder.run,
    });
    const output = await subject.remote(["fetch"]);
    assert.equal(output.stdout, "fatal: *** and ***");
    assert.equal(output.stderr, "fatal: *** and ***");
    const error = await rejection(subject.remoteRequired(["-c", "a=b", "fetch", "x"]));
    assert.ok(error instanceof StageError);
    assert.equal(error.code, "STAGE_GIT_FAILED");
    assert.equal(error.message, "git fetch failed: fatal: *** and ***");
    const local = await rejection(subject.run(["status"]));
    assert.equal((local as StageError).message, "git status failed: fatal: *** and ***");
  });

  it("describes a failed command without its -c settings", () => {
    const output = { exitCode: 1, stdout: "", stderr: " boom \n" };
    assert.equal(
      gitFailed(["-c", "x=y", "push", "u"], output).message,
      "git push failed: boom",
    );
  });
});

describe("checkedOutBranch", () => {
  it("returns the branch checked out by name", async () => {
    const fixture = await makeGitFixture("git-");
    assert.equal(await checkedOutBranch(fixtureGit(fixture)), "main");
  });

  it("rejects a detached HEAD", async () => {
    const fixture = await makeGitFixture("git-");
    git(fixture.workspace, "checkout", "--quiet", "--detach");
    const error = await rejection(checkedOutBranch(fixtureGit(fixture)));
    assert.equal((error as StageError).code, "STAGE_INPUT_INVALID");
  });
});

describe("prepareBranch", () => {
  const options = { base: "main", branch: "nibfin/issue-1", actor: fakeActor };

  it("creates a new branch from origin/<base> with the actor's identity", async () => {
    const fixture = await makeGitFixture("git-");
    const main = commitFile(fixture.other, "b.txt", "b\n", "newer main");
    git(fixture.other, "push", "--quiet", "origin", "main");
    const subject = fixtureGit(fixture);
    const prepared = await prepareBranch(subject, options);
    assert.deepEqual(prepared, {
      base: "main",
      branch: "nibfin/issue-1",
      remoteHead: undefined,
    });
    assert.equal(git(fixture.workspace, "rev-parse", "HEAD"), main);
    assert.equal(await checkedOutBranch(subject), "nibfin/issue-1");
    assert.equal(git(fixture.workspace, "config", "user.name"), "nibfin-bot");
    assert.equal(
      git(fixture.workspace, "config", "user.email"),
      "42+nibfin-bot@users.noreply.github.com",
    );
  });

  it("checks out the pushed branch and returns its remote head", async () => {
    const fixture = await makeGitFixture("git-");
    git(fixture.other, "checkout", "--quiet", "-b", "nibfin/issue-1");
    const pushed = commitFile(fixture.other, "w.txt", "w\n", "work");
    git(fixture.other, "push", "--quiet", "origin", "nibfin/issue-1");
    const subject = fixtureGit(fixture);
    const prepared = await prepareBranch(subject, options);
    assert.equal(prepared.remoteHead, pushed);
    assert.equal(await readBranchHead(subject, "nibfin/issue-1"), pushed);
    assert.equal(await readBranchHead(subject, "nibfin/none"), undefined);
    assert.equal(await commitsAhead(subject, "main"), 1);
    assert.deepEqual(await messagesAhead(subject, "main"), ["work"]);
    assert.match(await diffAgainstBase(subject, "main"), /\+\+\+ b\/w\.txt/);
  });

  it("unshallows a shallow checkout so a merge base exists", async () => {
    const fixture = await makeGitFixture("git-");
    commitFile(fixture.other, "b.txt", "b\n", "second");
    git(fixture.other, "push", "--quiet", "origin", "main");
    const shallow = join(fixture.root, "shallow");
    const url = `file://${fixture.remote.replaceAll("\\", "/")}`;
    git(fixture.root, "clone", "--quiet", "--depth", "1", url, shallow);
    const subject = new Git({
      workspace: shallow,
      remoteUrl: fixture.remote,
      token: fakeToken,
      run: recordingGit().run,
    });
    await prepareBranch(subject, options);
    assert.equal(git(shallow, "rev-parse", "--is-shallow-repository"), "false");
    assert.equal(git(shallow, "rev-list", "--count", "HEAD"), "2");
  });

  it("fails when the remote cannot be read", async () => {
    const fixture = await makeGitFixture("git-");
    const subject = new Git({
      workspace: fixture.workspace,
      remoteUrl: join(fixture.root, "missing.git"),
      token: fakeToken,
      run: recordingGit().run,
    });
    const error = await rejection(prepareBranch(subject, options));
    assert.equal((error as StageError).code, "STAGE_GIT_FAILED");
  });
});

describe("messagesAhead", () => {
  it("returns each full message ahead of the base", async () => {
    const fixture = await makeGitFixture("git-");
    const subject = fixtureGit(fixture);
    await prepareBranch(subject, { base: "main", branch: "x/y", actor: fakeActor });
    assert.deepEqual(await messagesAhead(subject, "main"), []);
    git(
      fixture.workspace,
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "one",
      "-m",
      "body",
    );
    git(fixture.workspace, "commit", "--quiet", "--allow-empty", "-m", "two");
    assert.deepEqual(await messagesAhead(subject, "main"), ["two", "one\n\nbody"]);
  });
});

describe("refFormat and refDirectory", () => {
  it("reads the ref backend; an echoed option means files", async () => {
    const fixture = await makeGitFixture("git-");
    assert.equal(await refFormat(fixtureGit(fixture)), "files");
    for (const [stdout, expected] of [
      ["reftable\n", "reftable"],
      ["--show-ref-format\n", "files"],
    ] as const) {
      const fake = recordingGit(() => ({ exitCode: 0, stdout, stderr: "" }));
      assert.equal(await refFormat(fixtureGit(fixture, fake.run)), expected);
    }
  });

  it("resolves the directory of the branch's loose ref", async () => {
    const fixture = await makeGitFixture("git-");
    const directory = await refDirectory(fixtureGit(fixture), "nibfin/issue-1");
    assert.equal(directory, resolve(fixture.workspace, ".git/refs/heads/nibfin"));
    const top = await refDirectory(fixtureGit(fixture), "topic");
    assert.equal(top, resolve(fixture.workspace, ".git/refs/heads"));
  });
});
