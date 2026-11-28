import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { failedRefusal, refusalBody, registrationBody } from "./answers.ts";

describe("runner request answers", () => {
  it("names the run of a failed request, or says it is unknown", () => {
    const url = "https://github.com/acme/app/actions/runs/9";
    assert.equal(
      failedRefusal(url).reason,
      "the request workflow failed (https://github.com/acme/app/actions/runs/9)",
    );
    assert.equal(
      failedRefusal(undefined).reason,
      "the request workflow failed (unknown)",
    );
  });

  it("writes a refusal as its reason, a blank line and the next step", () => {
    assert.equal(refusalBody({ reason: "r", next: "n" }), "reason: r\n\nn\n");
  });

  it("keeps one newline after the armored ciphertext", () => {
    const body = registrationBody(
      { owner: "acme", repo: "app" },
      { login: "ann", keyId: "5", expiresAt: "e", ciphertext: "ARMOR\n\n" },
    );
    assert.ok(body.endsWith("```text\nARMOR\n```\n"));
  });
});
