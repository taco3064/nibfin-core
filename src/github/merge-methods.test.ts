import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GitHubError } from "./errors.ts";
import { fakeGitHub, networkError, paged, rejection, repo } from "./fake-github.test.ts";
import {
  allowedMergeMethods,
  type MergeRules,
  type MergeSettings,
  readMergeRules,
  readMergeSettings,
} from "./merge-methods.ts";

const all: MergeSettings = { rebase: true, squash: true, merge: true };
const noRules: MergeRules = { pullRequest: [], linearHistory: false };

function rule(allowedMethods?: Array<"merge" | "squash" | "rebase">) {
  return {
    requiredApprovals: 0,
    codeOwnerReview: false,
    lastPushApproval: false,
    threadResolution: false,
    allowedMethods,
  };
}

describe("readMergeSettings", () => {
  it("reads the three merge settings of the repository", async () => {
    const github = fakeGitHub({
      "GET /repos/acme/app": {
        data: { allow_rebase_merge: false, allow_squash_merge: true },
      },
    });
    assert.deepEqual(await readMergeSettings(github.client, repo), {
      rebase: false,
      squash: true,
      merge: undefined,
    });
  });

  it("fails when the repository cannot be read", async () => {
    const github = fakeGitHub({ "GET /repos/acme/app": networkError() });
    const error = await rejection(readMergeSettings(github.client, repo));
    assert.equal((error as GitHubError).code, "GITHUB_READ_FAILED");
  });
});

describe("readMergeRules", () => {
  it("reads every pull_request rule and linear history", async () => {
    const rules = [
      { type: "required_status_checks", parameters: { required_status_checks: [] } },
      {
        type: "pull_request",
        parameters: {
          required_approving_review_count: 2,
          require_code_owner_review: true,
          require_last_push_approval: true,
          required_review_thread_resolution: true,
          dismiss_stale_reviews_on_push: false,
          allowed_merge_methods: ["squash"],
        },
      },
      { type: "pull_request" },
      { type: "required_linear_history" },
    ];
    const github = fakeGitHub({
      "GET /repos/acme/app/rules/branches/main": paged(rules),
    });
    const read = await readMergeRules(github.client, repo, "main");
    assert.deepEqual(read, {
      pullRequest: [
        {
          requiredApprovals: 2,
          codeOwnerReview: true,
          lastPushApproval: true,
          threadResolution: true,
          allowedMethods: ["squash"],
        },
        rule(undefined),
      ],
      linearHistory: true,
    });
    assert.equal(github.calls[0]?.query.get("per_page"), "100");
  });

  it("reads no rules as no restriction", async () => {
    const github = fakeGitHub({
      "GET /repos/acme/app/rules/branches/main": paged([]),
    });
    assert.deepEqual(await readMergeRules(github.client, repo, "main"), noRules);
  });

  it("fails when the rules cannot be read", async () => {
    const github = fakeGitHub();
    const error = await rejection(readMergeRules(github.client, repo, "main"));
    assert.equal((error as GitHubError).code, "GITHUB_READ_FAILED");
  });
});

describe("allowedMergeMethods", () => {
  const cases: Array<[string, MergeSettings, MergeRules, unknown]> = [
    ["every method in order", all, noRules, ["rebase", "squash", "merge"]],
    [
      "only what the settings allow",
      { rebase: false, squash: true, merge: true },
      noRules,
      ["squash", "merge"],
    ],
    [
      "the intersection of every pull_request rule",
      all,
      {
        pullRequest: [rule(["merge", "squash"]), rule(["squash"]), rule()],
        linearHistory: false,
      },
      ["squash"],
    ],
    [
      "no merge commit under linear history",
      { rebase: false, squash: false, merge: true },
      { pullRequest: [], linearHistory: true },
      [],
    ],
    [
      "nothing when settings and rules share no method",
      { rebase: true, squash: false, merge: false },
      { pullRequest: [rule(["merge"])], linearHistory: false },
      [],
    ],
    [
      "unknown when a setting is missing",
      { rebase: true, squash: undefined, merge: true },
      noRules,
      undefined,
    ],
  ];
  for (const [name, settings, rules, expected] of cases) {
    it(`gives ${name}`, () => {
      assert.deepEqual(allowedMergeMethods(settings, rules), expected);
    });
  }
});
