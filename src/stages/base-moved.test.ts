import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GitHubError } from "../github/errors.ts";
import {
  failure,
  fakeActor,
  fakeGitHub,
  paged,
  rejection,
  repo,
} from "../github/fake-github.test.ts";
import { pull } from "../github/fixtures.test.ts";
import {
  baseCommitLimit,
  baseMovedDefect,
  describeNewBaseCommits,
  rebaseInstructions,
} from "./base-moved.ts";
import { commitFile, fixtureGit, git, makeGitFixture } from "./fake-git.test.ts";
import { prepareBranch } from "./git.ts";

/** A prepared branch whose base then gained `count` commits on GitHub. */
async function movedBase(count: number) {
  const fixture = await makeGitFixture("base-");
  const subject = fixtureGit(fixture);
  await prepareBranch(subject, {
    base: "main",
    branch: "nibfin/issue-1",
    actor: fakeActor,
  });
  const shas: string[] = [];
  for (let index = 1; index <= count; index += 1) {
    shas.push(commitFile(fixture.other, `f${index}.txt`, "x\n", `feat: f${index}`));
  }
  git(fixture.other, "push", "--quiet", "origin", "main");
  git(fixture.workspace, "fetch", "--quiet", "origin");
  return { fixture, subject, shas };
}

describe("describeNewBaseCommits", () => {
  it("lists the newest commits with their PRs and counts the rest", async () => {
    const { subject, shas } = await movedBase(baseCommitLimit + 1);
    const github = fakeGitHub();
    for (const sha of shas) {
      github.routes.set(`GET /repos/acme/app/commits/${sha}/pulls`, paged([]));
    }
    const newest = shas.at(-1)!;
    github.routes.set(
      `GET /repos/acme/app/commits/${newest}/pulls`,
      paged([
        { ...pull(330), title: "Add the widget" },
        { ...pull(331), title: "Fix it" },
      ]),
    );
    const scope = { git: subject, client: github.client, repo, base: "main" };
    const text = await describeNewBaseCommits(scope);
    const lines = text.split("\n");
    assert.equal(lines[0], "Commits on `main` that the branch does not have:");
    const short = newest.slice(0, 7);
    assert.match(
      lines[2],
      new RegExp(
        `^- ${short}\\w* feat: f${shas.length} \\(#330 Add the widget ` +
          "\\(https://github\\.com/acme/app/pull/330\\); " +
          "#331 Fix it \\(.*/pull/331\\)\\)$",
      ),
    );
    assert.match(lines[3], /^- \w+ feat: f50 \(no pull request\)$/);
    assert.equal(lines.length, 2 + baseCommitLimit + 1);
    assert.equal(lines.at(-1), "- and 1 more");
    const reads = github.calls.filter((call) => call.path.endsWith("/pulls"));
    assert.equal(reads.length, baseCommitLimit);
  });

  it("fails when the pull requests of a commit cannot be read", async () => {
    const { subject, shas } = await movedBase(1);
    const github = fakeGitHub({
      [`GET /repos/acme/app/commits/${shas[0]}/pulls`]: failure(500),
    });
    const scope = { git: subject, client: github.client, repo, base: "main" };
    const error = await rejection(baseMovedDefect(scope, shas[0]));
    assert.ok(error instanceof GitHubError);
    assert.equal(error.code, "GITHUB_READ_FAILED");
  });
});

describe("baseMovedDefect", () => {
  it("names the new base head, the rebase and the commits", async () => {
    const { subject, shas } = await movedBase(1);
    const github = fakeGitHub({
      [`GET /repos/acme/app/commits/${shas[0]}/pulls`]: paged([]),
    });
    const scope = { git: subject, client: github.client, repo, base: "main" };
    const text = await baseMovedDefect(scope, shas[0]);
    assert.ok(
      text.startsWith(
        `The base branch \`main\` moved to ${shas[0]} while this delivery ran. ` +
          rebaseInstructions("main"),
      ),
    );
    assert.match(rebaseInstructions("main"), /onto `refs\/remotes\/origin\/main`/);
    assert.match(rebaseInstructions("main"), /cannot fetch it yourself/);
    assert.match(text, /\n\nCommits on `main` that the branch does not have:\n\n- /);
  });
});
