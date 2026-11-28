import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { StageError } from "./errors.ts";
import { agentResult } from "./fake-job.test.ts";
import {
  investigationRole,
  parseInvestigationResult,
  parsePlanResult,
  type PlanContext,
  planRole,
} from "./scope-roles.ts";

const requestUrl = "https://github.com/acme/app/issues/1";
const reuseUrl = "https://github.com/acme/lib/issues/7";
const context: PlanContext = {
  requestUrl,
  repositories: new Set(["acme/app", "acme/lib"]),
  originUrls: new Set([reuseUrl]),
};

function invalid(run: () => unknown, pattern: RegExp) {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof StageError);
    assert.equal(error.code, "STAGE_RESULT_INVALID");
    assert.match(error.message, pattern);
    return true;
  });
}

describe("scope role formats", () => {
  it("say the stage posts reason at the request repository's visibility", () => {
    for (const role of [investigationRole, planRole]) {
      assert.equal(role.readOnly, true);
      assert.match(role.resultFormat, /posts `reason` on the request as written/);
      assert.match(role.resultFormat, /An `internal` repository counts as private/);
    }
    assert.equal(investigationRole.skill, "shape");
    assert.equal(planRole.skill, "scope");
    assert.match(planRole.resultFormat, /target repository's visibility/);
  });
});

describe("parseInvestigationResult", () => {
  it("reads each judgment", () => {
    assert.deepEqual(
      parseInvestigationResult(
        agentResult({
          outcome: "feasible",
          reason: "Doable",
          repositories: ["acme/lib", "acme/lib", "acme/app"],
        }),
      ),
      { outcome: "feasible", reason: "Doable", repositories: ["acme/lib", "acme/app"] },
    );
    const covering = "https://github.com/acme/app/issues/3";
    for (const value of [covering, null]) {
      assert.deepEqual(
        parseInvestigationResult(
          agentResult({ outcome: "already-covered", reason: "Done", covering: value }),
        ),
        { outcome: "already-covered", reason: "Done", covering: value },
      );
    }
    for (const outcome of ["not-feasible", "needs-person"]) {
      assert.deepEqual(
        parseInvestigationResult(agentResult({ outcome, reason: "Why" })),
        { outcome, reason: "Why" },
      );
    }
  });

  it("rejects missing reasons, repositories and bad covering URLs", () => {
    invalid(
      () => parseInvestigationResult(agentResult({ outcome: "not-feasible" })),
      /reason must be a non-empty string/,
    );
    for (const repositories of [[], ["acme"], [1], "acme/app"]) {
      invalid(
        () =>
          parseInvestigationResult(
            agentResult({ outcome: "feasible", reason: "x", repositories }),
          ),
        /repositories must be a non-empty list/,
      );
    }
    for (const covering of ["https://github.com/acme/app/pull/3", 3, undefined]) {
      invalid(
        () =>
          parseInvestigationResult(
            agentResult({ outcome: "already-covered", reason: "x", covering }),
          ),
        /covering must be an Issue URL or null/,
      );
    }
  });
});

const body = `Do it.\n\nOrigin: ${requestUrl}`;
const fresh = (key: string, blockedBy: string[] = []) => ({
  key,
  repository: "acme/lib",
  title: `Title ${key}`,
  body,
  blockedBy,
});
const ready = (issues: unknown, extra: Record<string, unknown> = {}) =>
  agentResult({
    outcome: "PLAN_READY",
    deduplication: "verified",
    report: "## Plan",
    issues,
    ...extra,
  });

describe("parsePlanResult", () => {
  it("reads a PLAN_READY plan with new and reused Issues", () => {
    const external = "https://github.com/other/repo/issues/2";
    const issues = [
      fresh("a"),
      fresh("b", ["a", external]),
      { key: "c", reuse: reuseUrl, blockedBy: ["b"] },
    ];
    assert.deepEqual(parsePlanResult(ready(issues), context), {
      outcome: "PLAN_READY",
      deduplication: "verified",
      report: "## Plan",
      issues,
    });
    const unverified = parsePlanResult(
      ready([fresh("a")], { deduplication: "unverified" }),
      context,
    );
    assert.equal(unverified.outcome, "PLAN_READY");
    assert.equal(
      unverified.outcome === "PLAN_READY" && unverified.deduplication,
      "unverified",
    );
  });

  it("reads PLAN_BLOCKED and AUTHORITY_UPDATE_REQUIRED", () => {
    for (const outcome of ["PLAN_BLOCKED", "AUTHORITY_UPDATE_REQUIRED"]) {
      assert.deepEqual(
        parsePlanResult(agentResult({ outcome, reason: "Gap" }), context),
        {
          outcome,
          reason: "Gap",
        },
      );
    }
  });

  const rejected: Array<[string, string, RegExp]> = [
    [
      "a bad deduplication",
      ready([fresh("a")], { deduplication: "maybe" }),
      /deduplication/,
    ],
    ["a missing report", ready([fresh("a")], { report: "" }), /report must be/],
    ["an empty plan", ready([]), /issues must be a non-empty list/],
    ["a list that is not one", ready("a"), /issues must be a non-empty list/],
    ["an entry that is no object", ready(["a"]), /issues\[0\] must be an object/],
    ["a missing key", ready([{ ...fresh("a"), key: "" }]), /issues\[0\]: key must be/],
    ["a duplicated key", ready([fresh("a"), fresh("a")]), /key "a" is duplicated/],
    [
      "an uninventoried repository",
      ready([{ ...fresh("a"), repository: "acme/other" }]),
      /issue "a": the stage read no inventory of acme\/other/,
    ],
    ["an empty title", ready([{ ...fresh("a"), title: " " }]), /issue "a": title must/],
    ["an empty body", ready([{ ...fresh("a"), body: "" }]), /issue "a": body must/],
    [
      "a body without the origin line",
      ready([{ ...fresh("a"), body: "Origin: elsewhere" }]),
      /issue "a": the body lacks the line Origin:/,
    ],
    [
      "a reuse URL that is not the request's own",
      ready([{ key: "a", reuse: "https://github.com/acme/lib/issues/9", blockedBy: [] }]),
      /issue "a": reuse .* is not one of the request's own Issues/,
    ],
    [
      "a reuse listed twice",
      ready([
        { key: "a", reuse: reuseUrl, blockedBy: [] },
        { key: "b", reuse: reuseUrl, blockedBy: [] },
      ]),
      /is reused twice/,
    ],
    [
      "a blockedBy that is no list",
      ready([{ ...fresh("a"), blockedBy: "b" }]),
      /issue "a": blockedBy must be a list of strings/,
    ],
    [
      "a blockedBy of non-strings",
      ready([{ ...fresh("a"), blockedBy: [1] }]),
      /issue "a": blockedBy must be a list of strings/,
    ],
    [
      "a null blockedBy",
      ready([{ ...fresh("a"), blockedBy: null }]),
      /issue "a": blockedBy must be a list of strings/,
    ],
    [
      "an unknown edge",
      ready([fresh("a", ["z"])]),
      /issue "a": blockedBy z is neither a key nor an Issue URL/,
    ],
    ["a self-edge", ready([fresh("a", ["a"])]), /issue "a" is blocked by itself/],
    [
      "a reuse blocked by itself",
      ready([{ key: "a", reuse: reuseUrl, blockedBy: [reuseUrl] }]),
      /issue "a" is blocked by itself/,
    ],
    [
      "a cycle",
      ready([fresh("a", ["c"]), fresh("b", ["a"]), fresh("c", ["b"])]),
      /blockedBy has a cycle: a -> c -> b -> a/,
    ],
  ];
  for (const [name, message, pattern] of rejected) {
    it(`rejects ${name}`, () => {
      invalid(() => parsePlanResult(message, context), pattern);
    });
  }

  it("reads a missing blockedBy as no dependencies", () => {
    const bare = { key: "a", repository: "acme/lib", title: "Title a", body };
    const issues = [bare, { key: "b", reuse: reuseUrl }, fresh("c", ["a", "b"])];
    assert.deepEqual(parsePlanResult(ready(issues), context), {
      outcome: "PLAN_READY",
      deduplication: "verified",
      report: "## Plan",
      issues: [
        { ...bare, blockedBy: [] },
        { key: "b", reuse: reuseUrl, blockedBy: [] },
        fresh("c", ["a", "b"]),
      ],
    });
    invalid(
      () => parsePlanResult(ready([bare, fresh("c", ["z"])]), context),
      /issue "c": blockedBy z is neither a key nor an Issue URL/,
    );
  });

  it("accepts a diamond of edges", () => {
    const plan = parsePlanResult(
      ready([fresh("a"), fresh("b", ["a"]), fresh("c", ["a"]), fresh("d", ["b", "c"])]),
      context,
    );
    assert.equal(plan.outcome, "PLAN_READY");
  });
});
