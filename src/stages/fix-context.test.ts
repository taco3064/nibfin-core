import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  failureContextLines,
  failureMarkers,
  failureSectionLines,
  logExcerpt,
  logTailLines,
} from "./fix-context.ts";

const url = "https://github.com/acme/app/actions/runs/7/job/9";

/** Lines `line 1` … `line <count>`, with `marks[n]` replacing line `n` (1-based). */
function log(count: number, marks: Record<number, string> = {}, eol = "\n"): string {
  const lines = Array.from({ length: count }, (_, index) => {
    const number = index + 1;
    return marks[number] ?? `line ${number}`;
  });
  return lines.join(eol) + eol;
}

/** The labelled line ranges of an excerpt, such as `["1–6", "301–500"]`. */
function ranges(excerpt: string): string[] {
  return [...excerpt.matchAll(/^Lines (\d+–\d+):$/gm)].map((match) => match[1]);
}

/** How many log lines the excerpt shows (the lines inside its fences). */
function shownLines(excerpt: string): number {
  return [...excerpt.matchAll(/^```text\n([\s\S]*?)\n```$/gm)].reduce(
    (sum, match) => sum + match[1].split("\n").length,
    0,
  );
}

describe("logExcerpt", () => {
  it("keeps failures in the middle with context, the tail, and says what was cut", () => {
    const total = 1000;
    const excerpt = logExcerpt(
      log(total, {
        300: "2026-11-28T10:00:00.0000000Z fatal error: found pointer to free object",
        600: "--- FAIL: TestWidget (0.01s)",
      }),
      url,
    );
    assert.deepEqual(ranges(excerpt), ["295–305", "595–605", "801–1000"]);
    assert.ok(excerpt.startsWith(`Job log excerpt (222 of ${total} lines):\n\n`));
    for (const line of [
      "fatal error: found pointer to free object",
      "--- FAIL: TestWidget (0.01s)",
      "line 295\n",
      "line 305\n",
      "line 595\n",
      "line 605\n",
      "line 801\n",
      "line 1000\n",
    ]) {
      assert.ok(excerpt.includes(line), line);
    }
    assert.ok(!excerpt.includes("line 294\n"));
    assert.ok(!excerpt.includes("line 306\n"));
    assert.ok(!excerpt.includes("line 800\n"));
    assert.ok(
      excerpt.endsWith(
        `\n\nLeft out: 778 lines outside the shown ranges. The full log is at ${url}.`,
      ),
    );
  });

  it("stays within the bound when there are many failure sections", () => {
    const marks: Record<number, string> = {};
    for (let line = 20; line <= 2000; line += 20) {
      marks[line] = `##[error]Process completed with exit code ${line}`;
    }
    const excerpt = logExcerpt(log(3000, marks), url);
    assert.equal(shownLines(excerpt), logTailLines + failureSectionLines);
    const shown = ranges(excerpt);
    assert.equal(shown[0], "15–25");
    assert.equal(shown.at(-1), "2801–3000");
    // 18 whole sections of 11 lines, then 2 lines of the 19th (375–385).
    assert.equal(shown.at(-2), "375–376");
    assert.ok(excerpt.includes("exit code 20\n"));
    assert.ok(!excerpt.includes("exit code 380"));
    assert.ok(
      excerpt.endsWith(
        "\n\nLeft out: 2600 lines outside the shown ranges. 82 failure section(s) " +
          "were left out or cut by the 200-line bound, from line 377. " +
          `The full log is at ${url}.`,
      ),
    );
  });

  it("merges overlapping and adjacent failure sections", () => {
    const gap = 2 * failureContextLines + 1;
    const excerpt = logExcerpt(
      log(1000, { 100: "panic: a", 104: "panic: b", [104 + gap]: "panic: c" }),
      url,
    );
    assert.deepEqual(ranges(excerpt), [`95–${104 + gap + 5}`, "801–1000"]);
  });

  it("joins a failure section that reaches the tail to the tail", () => {
    const excerpt = logExcerpt(log(1000, { 795: "Exception 0xc0000005" }), null);
    assert.deepEqual(ranges(excerpt), ["790–1000"]);
    assert.ok(
      excerpt.endsWith(
        "\n\nLeft out: 789 lines outside the shown ranges. " +
          "The full log is at the job's page on GitHub.",
      ),
    );
  });

  it("ignores markers inside the tail, which is shown anyway", () => {
    const excerpt = logExcerpt(log(300, { 1: "line one", 250: "panic: late" }), url);
    assert.deepEqual(ranges(excerpt), ["101–300"]);
    assert.ok(excerpt.includes("panic: late"));
  });

  it("shows a short log whole with no note", () => {
    const text = log(logTailLines, { 3: "--- FAIL: TestA" });
    assert.equal(
      logExcerpt(text, url),
      `Job log excerpt (${logTailLines} of ${logTailLines} lines):\n\n` +
        `Lines 1–${logTailLines}:\n\n\`\`\`text\n${text.slice(0, -1)}\n\`\`\``,
    );
    assert.equal(
      logExcerpt("no newline at the end", undefined),
      "Job log excerpt (1 of 1 lines):\n\nLines 1–1:\n\n" +
        "```text\nno newline at the end\n```",
    );
  });

  it("says when the log is empty", () => {
    assert.equal(logExcerpt("", url), "Job log excerpt (0 lines): the job log is empty.");
  });

  it("finds every marker anywhere in a line, with CRLF line endings", () => {
    for (const marker of failureMarkers) {
      const excerpt = logExcerpt(
        log(1000, { 400: `2026-11-28T10:00:00Z ${marker} boom` }, "\r\n"),
        url,
      );
      assert.deepEqual(ranges(excerpt), ["395–405", "801–1000"], marker);
      assert.ok(excerpt.includes(`${marker} boom\nline 401\n`), marker);
      assert.ok(!excerpt.includes("\r"), marker);
    }
  });
});
