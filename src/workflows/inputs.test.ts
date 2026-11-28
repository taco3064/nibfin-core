import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { flow, type RenderRequest, templateData, WorkflowInputError } from "./inputs.ts";

const digest = `ghcr.io/taco3064/nibfin@sha256:${"0".repeat(64)}`;
const commit = "0123456789abcdef0123456789abcdef01234567";

function request(overrides: Partial<RenderRequest> = {}): RenderRequest {
  return {
    set: "execution",
    channel: "own",
    image: "ghcr.io/taco3064/nibfin:main",
    defaultBranch: "main",
    workflows: ["CI", "Image"],
    ...overrides,
  };
}

function rejects(overrides: Partial<RenderRequest>, message: RegExp) {
  assert.throws(
    () => templateData(request(overrides)),
    (error: unknown) =>
      error instanceof WorkflowInputError &&
      error.code === "WORKFLOW_INPUT_INVALID" &&
      message.test(error.message),
  );
}

describe("templateData", () => {
  it("builds the own channel's data", () => {
    assert.deepEqual(templateData(request()), {
      set: "execution",
      channel: "own",
      imageRepository: "ghcr.io/taco3064/nibfin",
      imageRef: undefined,
      imageTag: "main",
      branches: '["main"]',
      workflows: '["CI", "Image"]',
      eventsToken: "${{ secrets.token }}",
      eventsUses: "./.github/workflows/nibfin-events.yml",
      actionUses: "taco3064/nibfin-core/action@main",
    });
  });

  it("calls Core's events workflow @main from an own peer", () => {
    const data = templateData(request({ set: "peer", image: undefined }));
    assert.equal(
      data.eventsUses,
      "taco3064/nibfin-core/.github/workflows/nibfin-events.yml@main",
    );
    assert.equal(data.imageTag, undefined);
    assert.equal(data.actionUses, "taco3064/nibfin-core/action@main");
  });

  it("pins the Action by commit for a user peer set", () => {
    const data = templateData(
      request({ set: "peer", channel: "user", image: undefined, commit }),
    );
    assert.equal(data.actionUses, `taco3064/nibfin-core/action@${commit}`);
  });

  it("builds the user channel's data", () => {
    const data = templateData(request({ channel: "user", image: digest, commit }));
    assert.equal(data.imageRef, digest);
    assert.equal(data.actionUses, `taco3064/nibfin-core/action@${commit}`);
    assert.equal(data.imageTag, undefined);
    assert.equal(data.eventsToken, "${{ secrets.NIBFIN_GITHUB_TOKEN }}");
    assert.equal(data.eventsUses, undefined);
  });

  it("leaves the workflow names empty when there are none", () => {
    assert.equal(templateData(request({ workflows: [] })).workflows, "");
  });

  it("sorts by UTF-8 bytes and deduplicates the workflow names", () => {
    // UTF-16 order would put the emoji (a surrogate pair) before U+FF61.
    const names = ["b", "\u{1f600}", "a", "b", "\uff61", "B"];
    assert.equal(
      templateData(request({ workflows: names })).workflows,
      '["B", "a", "b", "\uff61", "\u{1f600}"]',
    );
  });

  it("accepts a tag of up to 128 characters", () => {
    const tag = `_${"a".repeat(127)}`;
    const image = `ghcr.io/taco3064/nibfin:${tag}`;
    assert.equal(templateData(request({ image })).imageTag, tag);
  });

  it("checks an image given for a peer set", () => {
    rejects({ set: "peer", image: "ghcr.io/taco3064/nibfin" }, /is not .*:<tag>/);
    rejects({ set: "peer", channel: "user", image: "x" }, /@sha256:<digest>/);
  });

  const cases: [string, Partial<RenderRequest>, RegExp][] = [
    ["an unknown set", { set: "all" }, /^set "all" is not execution or peer$/],
    ["a missing set", { set: "" }, /^set "" is not execution or peer$/],
    ["an unknown channel", { channel: "x" }, /^channel "x" is not own or user$/],
    ["an execution set without an image", { image: undefined }, /needs an image/],
    ["a tag for the user channel", { channel: "user" }, /@sha256:<digest>/],
    [
      "an upper-case digest",
      { channel: "user", image: digest.replace(/0$/, "A") },
      /@sha256:<digest>/,
    ],
    ["a short digest", { channel: "user", image: digest.slice(0, -1) }, /<digest>/],
    ["a digest for the own channel", { image: digest }, /nibfin:<tag>"?$/],
    ["another repository", { image: "ghcr.io/other/nibfin:main" }, /:<tag>$/],
    ["a tag that starts with a dot", { image: "ghcr.io/taco3064/nibfin:.x" }, /:<tag>/],
    [
      "a tag of 129 characters",
      { image: `ghcr.io/taco3064/nibfin:${"a".repeat(129)}` },
      /:<tag>/,
    ],
    ["a commit for the own channel", { commit }, /^the own channel takes no commit/],
    [
      "a user channel without a commit",
      { channel: "user", image: digest },
      /^the user channel needs a commit$/,
    ],
    [
      "a short commit",
      { channel: "user", image: digest, commit: commit.slice(1) },
      /^commit "[0-9a-f]{39}" is not a full 40-character SHA$/,
    ],
    [
      "an upper-case commit",
      { channel: "user", image: digest, commit: commit.toUpperCase() },
      /is not a full 40-character SHA/,
    ],
    [
      "a commit with a line break",
      { channel: "user", image: digest, commit: `${commit}\n` },
      /is not a full 40-character SHA/,
    ],
    ["an empty branch", { defaultBranch: "" }, /^default branch "" is empty/],
    ["a double quote in the branch", { defaultBranch: 'a"b' }, /quote or control/],
    ["a single quote in the branch", { defaultBranch: "a'b" }, /quote or control/],
    ["a control character in the branch", { defaultBranch: "a\u0007" }, /control/],
    ["a C1 control in the branch", { defaultBranch: "a\u0085" }, /control/],
    ["an empty workflow name", { workflows: ["CI", ""] }, /^workflow name ""/],
    ["a blank workflow name", { workflows: [" \t\u3000"] }, /empty or has a/],
    ["a line break in a workflow name", { workflows: ["a\nb"] }, /control character/],
  ];
  for (const [name, overrides, message] of cases) {
    it(`rejects ${name}`, () => rejects(overrides, message));
  }
});

describe("flow", () => {
  it("JSON-quotes each item as Go's encoding/json does", () => {
    assert.equal(
      flow(['a"b\\c', "x\u2028y\u2029z", "<&>"]),
      String.raw`["a\"b\\c", "x\u2028y\u2029z", "<&>"]`,
    );
  });

  it("writes an empty sequence", () => {
    assert.equal(flow([]), "[]");
  });
});
