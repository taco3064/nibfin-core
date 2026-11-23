import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, type FSWatcher, rmSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { makeTempDir } from "../agent/fake-cli.test.ts";
import { watchRefDirectory } from "./ref-watcher.ts";

/** A watcher the test drives: `fire` is a change, `fail` an error. */
class FakeWatcher extends EventEmitter {
  closed = false;
  listener: () => void;

  constructor(listener: () => void) {
    super();
    this.listener = listener;
  }

  close() {
    this.closed = true;
  }
}

function fakeWatch() {
  const watchers: FakeWatcher[] = [];
  const fake = ((_: string, listener: () => void) => {
    const watcher = new FakeWatcher(listener);
    watchers.push(watcher);
    return watcher as unknown as FSWatcher;
  }) as unknown as typeof watch;
  return { fake, watchers };
}

describe("watchRefDirectory", () => {
  it("reports changes in the directory and stops after close", async () => {
    const root = await makeTempDir("watch-");
    const directory = join(root, "refs", "heads", "nibfin");
    let notify: (() => void) | undefined;
    let events = 0;
    const watcher = watchRefDirectory(
      directory,
      () => {
        events += 1;
        notify?.();
      },
      { watch, log: () => undefined },
    );
    const changed = new Promise<void>((resolve) => (notify = resolve));
    writeFileSync(join(directory, "issue-1.lock"), "x");
    await changed;
    assert.ok(events > 0);
    watcher.close();
  });

  it("watches again when the directory was replaced", async () => {
    const root = await makeTempDir("watch-");
    const directory = join(root, "refs");
    const { fake, watchers } = fakeWatch();
    let events = 0;
    const watcher = watchRefDirectory(directory, () => (events += 1), {
      watch: fake,
      log: () => undefined,
    });
    watchers[0].listener();
    assert.equal(watchers.length, 1);
    rmSync(directory, { recursive: true });
    watchers[0].listener();
    assert.equal(events, 2);
    assert.equal(watchers.length, 2);
    assert.ok(existsSync(directory));
    assert.equal(watchers[0].closed, true);
    watcher.close();
    assert.equal(watchers[1].closed, true);
  });

  it("watches again after an error and reports it as an event", async () => {
    const root = await makeTempDir("watch-");
    const { fake, watchers } = fakeWatch();
    const logs: string[] = [];
    let events = 0;
    const watcher = watchRefDirectory(join(root, "refs"), () => (events += 1), {
      watch: fake,
      log: (line) => logs.push(line),
    });
    watchers[0].emit("error", new Error("EMFILE"));
    assert.equal(watchers.length, 2);
    assert.equal(events, 1);
    assert.deepEqual(logs, ["The ref watcher failed (Error: EMFILE); watching again"]);
    watcher.close();
    watchers[1].emit("error", new Error("late"));
    assert.equal(watchers.length, 2);
  });

  it("falls back to the final push when the directory cannot be watched", async () => {
    const root = await makeTempDir("watch-");
    const logs: string[] = [];
    const failing = (() => {
      throw new Error("ENOSPC");
    }) as unknown as typeof watch;
    const watcher = watchRefDirectory(join(root, "refs"), () => undefined, {
      watch: failing,
      log: (line) => logs.push(line),
    });
    assert.match(logs[0], /^Cannot watch .*\(Error: ENOSPC\); progress is saved by/);
    watcher.close();
  });
});
