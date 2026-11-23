import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { closingMessages } from "./closing-keywords.ts";

const issue = { owner: "acme", repo: "app.js", number: 12 };

describe("closingMessages", () => {
  for (const message of [
    "feat: add it\n\nCloses #12",
    "Fixes: #12",
    "resolved acme/app.js#12",
    "close https://github.com/acme/app.js/issues/12",
    "FIXED   #12.",
  ]) {
    it(`finds ${JSON.stringify(message)}`, () => {
      assert.deepEqual(closingMessages([message], issue), [message]);
    });
  }

  for (const message of [
    "Part of #12",
    "Closes #123",
    "Closes #1",
    "Closes other/app#12",
    "Closes acme/app#12",
    "enclose #12",
    "fix #12/x",
    "Closes https://github.com/acme/app.js/issues/120",
  ]) {
    it(`ignores ${JSON.stringify(message)}`, () => {
      assert.deepEqual(closingMessages([message], issue), []);
    });
  }
});
