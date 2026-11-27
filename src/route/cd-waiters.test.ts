import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { nibfinPushRun } from "../github/fixtures.test.ts";
import { redMain, routeRun, sha } from "./fake-red-main.test.ts";

const headsCalls = (red: Awaited<ReturnType<typeof redMain>>) =>
  red.world.issues.github.calls.filter((call) =>
    /\/actions\/workflows\/\d+\/runs$/.test(call.path),
  ).length;

describe("cdWaiters (#772)", () => {
  it("reads one head page on a green main and wakes nobody", async () => {
    const red = await redMain();
    red.addIssue(2);
    red.merge(5, "nibfin/issue-2", sha.m1, { CI: "success" });
    const result = await red.cli("--sha", sha.m1);
    assert.equal(result.code, 0);
    assert.deepEqual(result.dispatched, [routeRun(2)]);
    assert.equal(headsCalls(red), 1);
    assert.match(result.out, /acme\/app@aaaa001: no Issue waits on it\n/);
  });

  it("wakes nobody for a push of no Issue that is not on the page", async () => {
    const red = await redMain();
    red.world.pushRuns.push({ ...nibfinPushRun(900, sha.m1), head_branch: "other" });
    const result = await red.cli("--sha", sha.m1);
    assert.equal(result.code, 0);
    assert.deepEqual(result.dispatched, []);
    assert.match(result.out, /belongs to no Issue; nothing to route\n/);
    assert.match(result.out, /not among the latest push heads of main; nothing to wake/);
  });

  it("wakes nobody while the head's CD is incomplete", async () => {
    const red = await redMain();
    const result = await red.cli("--sha", "abcdef1");
    assert.deepEqual(result.dispatched, []);
    assert.match(result.out, /CD is not complete on main/);
    assert.equal(headsCalls(red), 0);
  });

  it("walks back over red heads to the first green one, skipping Issues", async () => {
    const red = await redMain();
    for (const number of [3, 4, 5, 6]) {
      red.addIssue(number);
    }
    red.issues.get(3)!.state = "closed";
    red.merge(60, "nibfin/issue-6", "bbbb001", { CI: "failure" });
    red.push("bbbb002", { CI: "success" });
    red.merge(30, "nibfin/issue-3", "bbbb003", { CI: "failure" });
    red.push("bbbb004", { CI: "failure" });
    red.merge(40, "nibfin/issue-4", "bbbb005", { CI: "failure" });
    red.merge(41, "nibfin/issue-4-cd-1", "bbbb006", { CI: "failure" });
    red.merge(50, "nibfin/issue-5", "bbbb007", { CI: "success" });
    const result = await red.cli("--sha", "bbbb007");
    assert.deepEqual(result.dispatched, [routeRun(5), routeRun(4)]);
    assert.match(result.out, /acme\/app#4: its red merge bbbb006 may wait on bbbb007/);
    // The excluded Issue itself is skipped, and a newer green head wakes nobody.
    const own = await red.cli("--sha", "bbbb006");
    assert.deepEqual(own.dispatched, [routeRun(4)]);
  });

  it("wakes every Issue merged to a red head (#771 included)", async () => {
    const red = await redMain();
    for (const number of [7, 8, 9]) {
      red.addIssue(number);
    }
    red.merge(70, "nibfin/issue-7", "cccc001", { CI: "failure" });
    // Issue 8's pull request merged to cccc001 without moving main (#771).
    red.world.pulls.push({
      number: 80,
      state: "closed",
      merged: true,
      head: "nibfin/issue-8",
      sha: "head-80",
      mergeSha: "cccc001",
    });
    red.merge(90, "nibfin/issue-9", "cccc002", { CI: "success" });
    const result = await red.cli("--sha", "cccc002");
    assert.deepEqual(result.dispatched, [routeRun(9), routeRun(7), routeRun(8)]);
  });
});
