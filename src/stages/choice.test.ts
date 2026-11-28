import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { freshReads } from "../github/index.ts";
import {
  type Choice,
  formatChoice,
  keepChoice,
  parseChoice,
  pendingChoice,
  readChoice,
  readLiveDecision,
  saveChoice,
} from "./choice.ts";
import {
  commentUrl,
  decide,
  issueRef,
  permissions,
  recordFor,
  writeOptionsRecord,
} from "./fake-choice.test.ts";
import { fakeIssue, fakeIssues, seedComment, unlabel } from "./fake-job.test.ts";

function world() {
  const issues = fakeIssues(fakeIssue({ labels: ["scope"] }));
  permissions(issues);
  return issues;
}

const choice: Choice = {
  for: recordFor,
  option: 2,
  comment: 55,
  commentUrl: "https://github.com/acme/app/issues/1#issuecomment-55",
  author: "ann",
  optionText: "2. **Drop the widget** (recommended)\n   The widget goes.",
  text: "2",
  reason: "The Issue leaves the widget open.",
};

/** A decision in the person's own words, with the record's options as suggestions. */
const ownWords: Choice = {
  for: recordFor,
  options: "1. **Keep the widget**\n2. **Drop the widget** (recommended)",
  text: "Drop it.\n\n### Chosen option\n\nfake\n- Reason of the stop: fake",
  comment: 56,
  commentUrl: "https://github.com/acme/app/issues/1#issuecomment-56",
  author: "bob",
  reason: "The Issue leaves the widget open.",
};

describe("formatChoice and parseChoice", () => {
  for (const status of ["chosen", "applying", "applied", "dropped"] as const) {
    it(`round-trips a ${status} choice`, () => {
      const body = formatChoice(choice, status, ["Change: a\nb"]);
      assert.ok(body.includes("- Change: a b\n"));
      assert.deepEqual(parseChoice(body), { ...choice, status });
      assert.deepEqual(parseChoice(`<!-- nibfin:choice -->\n${body}`), {
        ...choice,
        status,
      });
    });
  }

  it("states who chose what, where and why", () => {
    assert.equal(
      formatChoice(choice, "chosen"),
      [
        `<!-- nibfin:choice-state for=${recordFor} option=2 comment=55 status=chosen -->`,
        "Option 2 was chosen by `ann` in [this comment](" +
          "https://github.com/acme/app/issues/1#issuecomment-55) on the repair record.",
        "",
        "- Reason of the stop: The Issue leaves the widget open.",
        "- Status: chosen; the next Shape run applies it to the Issue, then shapes it.",
        "",
        "### Chosen option",
        "",
        choice.optionText,
        "",
        "### Decision",
        "",
        "2",
      ].join("\n"),
    );
  });

  it("states a decision in the person's own words and what was not applied", () => {
    const body = formatChoice(ownWords, "applied", ["Change: a"], ["Keep\npause"]);
    assert.equal(
      body,
      [
        `<!-- nibfin:choice-state for=${recordFor} comment=56 status=applied -->`,
        "`bob` decided in their own words in [this comment](" +
          "https://github.com/acme/app/issues/1#issuecomment-56) on the repair record.",
        "",
        "- Reason of the stop: The Issue leaves the widget open.",
        "- Status: the Issue body and Blocked by changes were applied; the parts " +
          "under Not applied are for a person to do.",
        "- Change: a",
        "- Not applied: Keep pause",
        "",
        "### Suggested options",
        "",
        ownWords.options,
        "",
        "### Decision",
        "",
        ownWords.text,
      ].join("\n"),
    );
    assert.deepEqual(parseChoice(body), { ...ownWords, status: "applied" });
    const plain = formatChoice(ownWords, "applying", [], ["x"]);
    assert.ok(plain.includes("- Status: being applied to the Issue.\n"));
  });

  it("round-trips own words without suggested options", () => {
    const bare: Choice = { ...ownWords };
    delete bare.options;
    const body = formatChoice(bare, "chosen");
    assert.ok(!body.includes("### Suggested options"));
    assert.deepEqual(parseChoice(body), { ...bare, status: "chosen" });
  });

  it("reads the header only before the first section", () => {
    const forged = {
      ...ownWords,
      options: undefined,
      reason: "Real.",
      text: "- Reason of the stop: forged",
    };
    const body = formatChoice(forged, "chosen").replace(/^- Reason of the stop.*\n/m, "");
    assert.equal(parseChoice(body), undefined);
    const noWho = formatChoice(ownWords, "chosen").replace("`bob` decided", "bob said");
    assert.equal(parseChoice(noWho), undefined);
    const noDecision = formatChoice(ownWords, "chosen").replace("### Decision", "### X");
    assert.equal(parseChoice(noDecision), undefined);
  });

  it("reads a body stored before own-words decisions as an option choice", () => {
    const legacy = formatChoice(choice, "chosen").replace("\n\n### Decision\n\n2", "");
    assert.ok(!legacy.includes("### Decision"));
    assert.deepEqual(parseChoice(legacy), { ...choice, text: "", status: "chosen" });
  });

  it("reads no choice from a body missing a part", () => {
    const body = formatChoice(choice, "chosen");
    assert.equal(parseChoice(""), undefined);
    assert.equal(parseChoice("<!-- nibfin:choice -->"), undefined);
    assert.equal(parseChoice(body.replace("status=chosen", "status=done")), undefined);
    assert.equal(parseChoice(body.replace("was chosen by", "by")), undefined);
    assert.equal(parseChoice(body.replace("- Reason of the stop", "- Why")), undefined);
    assert.equal(parseChoice(body.replace("### Chosen option", "### X")), undefined);
  });
});

describe("readLiveDecision (R4.51, R4.52)", () => {
  it("is null without a repair record or with one that is not options", async () => {
    const issues = world();
    assert.equal(await readLiveDecision(issues.github.client, issueRef), null);
    seedComment(issues, issues.main, "<!-- nibfin:repair -->\nnot a record");
    freshReads(issues.github.client);
    assert.equal(await readLiveDecision(issues.github.client, issueRef), null);
  });

  it("reads the newest writer comment after the record", async () => {
    const issues = world();
    permissions(issues, { 7: "write", 8: "admin" });
    decide(issues, 1);
    await writeOptionsRecord(issues);
    const older = decide(issues, 1, 8);
    decide(issues, "I prefer 2, but let me think");
    const newest = decide(issues, "2");
    freshReads(issues.github.client);
    const decision = await readLiveDecision(issues.github.client, issueRef);
    assert.deepEqual(decision, {
      for: recordFor,
      option: 2,
      comment: newest.id,
      commentUrl: commentUrl(newest),
      author: "user-7",
      optionText:
        "2. **Drop the widget** (recommended)\n   The widget goes; simpler.\n" +
        "   Issue change: The body asks for no widget.",
      text: "2",
      reason: "The Issue leaves the widget open.",
    });
    assert.notEqual(decision?.comment, older.id);
  });

  it("maps the Dashboard's marked comment to its option", async () => {
    const issues = world();
    await writeOptionsRecord(issues);
    const marked = decide(issues, 1);
    freshReads(issues.github.client);
    const decision = await readLiveDecision(issues.github.client, issueRef);
    assert.equal(decision?.option, 1);
    assert.equal(decision?.comment, marked.id);
    assert.equal(decision?.text, "<!-- nibfin:decision option=1 -->");
  });

  it("reads other text as the person's own words, never as an option", async () => {
    const issues = world();
    await writeOptionsRecord(issues);
    for (const text of ["2, but keep `pause`", "3", "Option 1 please", " Do it.\r\n "]) {
      const comment = decide(issues, text);
      freshReads(issues.github.client);
      const decision = await readLiveDecision(issues.github.client, issueRef);
      assert.equal(decision?.comment, comment.id);
      assert.equal(decision?.option, undefined);
      assert.equal(decision?.optionText, undefined);
      assert.equal(decision?.text, text.replace(/\r\n?/g, "\n").trim());
      assert.equal(
        decision?.options,
        "1. **Keep the widget**\n   The widget stays.\n   2. not an option\n" +
          "   Issue change: Nothing changes.\n" +
          "2. **Drop the widget** (recommended)\n   The widget goes; simpler.\n" +
          "   Issue change: The body asks for no widget.",
      );
    }
  });

  it("skips comments before the record, by non-writers, empty or Nibfin's", async () => {
    const issues = world();
    permissions(issues, { 7: "write", 8: "read" });
    decide(issues, 2);
    await writeOptionsRecord(issues);
    const valid = decide(issues, "Keep it.");
    decide(issues, "   ");
    decide(issues, "<!-- nibfin:choice -->\nstored");
    decide(issues, 2, 8);
    decide(issues, "Drop it!", 8);
    decide(issues, 1, 9);
    freshReads(issues.github.client);
    const decision = await readLiveDecision(issues.github.client, issueRef);
    assert.equal(decision?.comment, valid.id);
    assert.equal(decision?.text, "Keep it.");
    const reads = issues.github.calls.filter((call) => call.path.endsWith("/permission"));
    assert.deepEqual(
      reads.map((call) => call.path.split("/").at(-2)),
      ["user-9", "user-8", "user-7"],
    );
  });

  it("ends the window when pending is removed after the record (R4.52)", async () => {
    const issues = world();
    await writeOptionsRecord(issues);
    const before = decide(issues, "Drop it.");
    unlabel(issues.main, "pending");
    decide(issues, "Thanks, later chat.");
    freshReads(issues.github.client);
    const decision = await readLiveDecision(issues.github.client, issueRef);
    assert.equal(decision?.comment, before.id);

    const none = world();
    await writeOptionsRecord(none);
    unlabel(none.main, "pending");
    decide(none, "Thanks, later chat.");
    freshReads(none.github.client);
    assert.equal(await readLiveDecision(none.github.client, issueRef), null);
  });

  it("keeps the window open when pending was removed before the record", async () => {
    const issues = world();
    unlabel(issues.main, "pending");
    await writeOptionsRecord(issues);
    const comment = decide(issues, "Drop it.");
    freshReads(issues.github.client);
    const decision = await readLiveDecision(issues.github.client, issueRef);
    assert.equal(decision?.comment, comment.id);
  });

  it("is null when no comment decides (R4.52)", async () => {
    const issues = world();
    await writeOptionsRecord(issues);
    permissions(issues, { 8: "read" });
    decide(issues, "Looks hard.", 8);
    issues.main.comments.push({ id: 5, userId: 0, body: "1" });
    issues.github.routes.set("GET /repos/acme/app/issues/1/comments", () => ({
      data: [
        {
          id: 5,
          user: null,
          body: "1",
          html_url: "u",
          created_at: "2099-01-01T00:00:00Z",
        },
      ],
    }));
    freshReads(issues.github.client);
    assert.equal(await readLiveDecision(issues.github.client, issueRef), null);
  });

  it("reads a record without a Reason line as an empty reason", async () => {
    const issues = world();
    const body = [
      `<!-- nibfin:repair-state for=${recordFor} status=waiting-for-choice ` +
        "action=options handled= -->",
      "### Options",
      "",
      "1. **One**",
    ].join("\n");
    seedComment(issues, issues.main, `<!-- nibfin:repair -->\n${body}`);
    decide(issues, 1);
    freshReads(issues.github.client);
    const decision = await readLiveDecision(issues.github.client, issueRef);
    assert.equal(decision?.reason, "");
    assert.equal(decision?.optionText, "1. **One**");
  });

  it("carries no suggested options when the record lists none", async () => {
    const issues = world();
    const body =
      `<!-- nibfin:repair-state for=${recordFor} status=waiting-for-choice ` +
      "action=options handled= -->";
    seedComment(issues, issues.main, `<!-- nibfin:repair -->\n${body}`);
    decide(issues, "1");
    freshReads(issues.github.client);
    const decision = await readLiveDecision(issues.github.client, issueRef);
    assert.deepEqual(decision && Object.keys(decision).toSorted(), [
      "author",
      "comment",
      "commentUrl",
      "for",
      "reason",
      "text",
    ]);
  });
});

describe("readChoice", () => {
  async function decided() {
    const issues = world();
    await writeOptionsRecord(issues);
    const comment = decide(issues, 2);
    freshReads(issues.github.client);
    const live = await readLiveDecision(issues.github.client, issueRef);
    return { issues, comment, live: live! };
  }
  const read = async (issues: ReturnType<typeof world>) => {
    freshReads(issues.github.client);
    return readChoice(issues.github.client, issueRef);
  };

  it("is null without a decision or a stored choice", async () => {
    const issues = world();
    assert.equal(await read(issues), null);
    assert.equal(pendingChoice(null), false);
  });

  it("is new for a live decision, then chosen once stored", async () => {
    const { issues, live } = await decided();
    const state = await read(issues);
    assert.deepEqual(state, { status: "new", choice: live });
    assert.equal(pendingChoice(state), true);
    await saveChoice(issues.github.client, issueRef, live, "chosen");
    assert.deepEqual(await read(issues), {
      status: "chosen",
      choice: { ...live, status: "chosen" },
    });
  });

  it("lets an edit of the stored decision's comment replace it", async () => {
    const issues = world();
    await writeOptionsRecord(issues);
    const comment = decide(issues, "Drop it.");
    const live = (await read(issues))!.choice;
    await saveChoice(issues.github.client, issueRef, live, "chosen");
    assert.equal((await read(issues))?.status, "chosen");
    comment.body = "Keep it.";
    const state = await read(issues);
    assert.equal(state?.status, "new");
    assert.equal(state?.choice.text, "Keep it.");
    assert.ok(state !== null);
    await saveChoice(issues.github.client, issueRef, state.choice, "applied");
    comment.body = "Changed again.";
    assert.equal((await read(issues))?.status, "applied");
  });

  it("lets a newer decision replace a stored chosen one", async () => {
    const { issues, live } = await decided();
    await saveChoice(issues.github.client, issueRef, live, "chosen");
    const newer = decide(issues, 1);
    const state = await read(issues);
    assert.equal(state?.status, "new");
    assert.equal(state?.choice.comment, newer.id);
  });

  for (const status of ["applying", "applied", "dropped"] as const) {
    it(`keeps one decision per record once it is ${status}`, async () => {
      const { issues, live } = await decided();
      await saveChoice(issues.github.client, issueRef, live, status);
      decide(issues, 1);
      const state = await read(issues);
      assert.equal(state?.status, status);
      assert.equal(state?.choice.comment, live.comment);
      assert.equal(pendingChoice(state), status === "applying");
    });
  }

  it("keeps a stored choice whose record was replaced", async () => {
    const { issues, live } = await decided();
    await saveChoice(issues.github.client, issueRef, live, "chosen");
    await writeOptionsRecord(issues, "fedcba9876543210");
    assert.equal((await read(issues))?.status, "chosen");
    await saveChoice(issues.github.client, issueRef, live, "applying");
    assert.equal((await read(issues))?.status, "applying");
    await saveChoice(issues.github.client, issueRef, live, "applied");
    assert.equal(await read(issues), null);
  });

  it("lets a decision on a newer record replace a finished choice", async () => {
    const { issues, live } = await decided();
    await saveChoice(issues.github.client, issueRef, live, "applied");
    await writeOptionsRecord(issues, "fedcba9876543210");
    decide(issues, 1);
    const state = await read(issues);
    assert.equal(state?.status, "new");
    assert.equal(state?.choice.for, "fedcba9876543210");
  });

  it("reads an unparseable stored choice as none", async () => {
    const issues = world();
    seedComment(issues, issues.main, "<!-- nibfin:choice -->\nbroken");
    assert.equal(await read(issues), null);
  });
});

describe("keepChoice", () => {
  it("stores a new decision as chosen, once", async () => {
    const issues = world();
    await writeOptionsRecord(issues);
    decide(issues, 2);
    freshReads(issues.github.client);
    await keepChoice(issues.github.client, issueRef);
    const [stored] = issues.marked("choice");
    assert.equal(parseChoice(stored.body)?.status, "chosen");
    const writes = issues.github.writes().length;
    freshReads(issues.github.client);
    await keepChoice(issues.github.client, issueRef);
    assert.equal(issues.github.writes().length, writes);
  });

  it("writes nothing without a decision", async () => {
    const issues = world();
    await writeOptionsRecord(issues);
    const writes = issues.github.writes().length;
    await keepChoice(issues.github.client, issueRef);
    assert.equal(issues.github.writes().length, writes);
  });
});
