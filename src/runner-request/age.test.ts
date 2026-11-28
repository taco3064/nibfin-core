import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { makeTempDir } from "../agent/fake-cli.test.ts";
import { AgeError, createAge } from "./age.ts";

// A fake `age`: `--version` exits with the code in its first variable-free argument;
// `-a -R <file>` prints what it got (arguments, recipient file, stdin, environment).
const script = `
import { readFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.exit(Number(process.argv[2] === "--version" ? 0 : process.argv[2]));
}
let stdin = "";
for await (const chunk of process.stdin) stdin += chunk;
const file = args[args.indexOf("-R") + 1];
const seen = {
  args,
  recipient: readFileSync(file, "utf8"),
  file,
  stdin,
  env: Object.keys(process.env),
};
process.stdout.write(JSON.stringify(seen) + "\\n\\n");
process.stderr.write("age: stderr is dropped\\n");
process.exit(stdin === "fail" ? 3 : 0);
`;

/** What the fake `age` prints for `-a -R`. */
interface Seen {
  args: string[];
  recipient: string;
  file: string;
  stdin: string;
  env: string[];
}

let dir: string;
let fake: string;

before(async () => {
  dir = await makeTempDir("age-");
  fake = join(dir, "age.mjs");
  await writeFile(fake, script);
});
after(() => rm(dir, { recursive: true, force: true }));

const env = { PATH: process.env.PATH, INPUT_TOKEN: "secret-token" };

function age(prefix: string[] = []) {
  return createAge(env, { command: process.execPath, args: [fake, ...prefix] });
}

describe("createAge check", () => {
  it("resolves when age --version runs", async () => {
    await age().check();
  });

  it("rejects when age --version fails", async () => {
    await assert.rejects(age(["2"]).check(), (error: unknown) => {
      assert.ok(error instanceof AgeError);
      assert.equal(error.code, "RUNNER_AGE_FAILED");
      assert.equal(error.message, "age --version failed (exit code 2)");
      return true;
    });
  });

  it("rejects when age cannot start", async () => {
    const missing = createAge(env, { command: join(fake, "missing-age"), args: [] });
    await assert.rejects(missing.check(), /^AgeError: age --version failed \(E[A-Z]+\)$/);
  });
});

describe("createAge encrypt", () => {
  it("encrypts stdin to the recipient file with only PATH, then removes it", async () => {
    const output = await age().encrypt("ssh-ed25519 AAAA", "REG-TOKEN");
    const seen = JSON.parse(output) as Seen;
    assert.deepEqual(seen.args, ["-a", "-R", seen.file]);
    assert.equal(seen.recipient, "ssh-ed25519 AAAA\n");
    assert.equal(seen.stdin, "REG-TOKEN");
    // Only PATH beyond what the platform and Node add to an empty environment.
    const bare = createAge({}, { command: process.execPath, args: [fake] });
    const base = (JSON.parse(await bare.encrypt("ssh-rsa AAAA", "x")) as Seen).env;
    assert.deepEqual(seen.env.toSorted(), [...new Set([...base, "PATH"])].toSorted());
    assert.ok(!seen.env.includes("INPUT_TOKEN"));
    assert.ok(output.endsWith("\n\n"));
    assert.equal(existsSync(seen.file), false);
  });

  it("rejects when age fails, never naming its input", async () => {
    await assert.rejects(age().encrypt("ssh-rsa AAAA", "fail"), (error: unknown) => {
      assert.ok(error instanceof AgeError);
      assert.equal(error.message, "age -a -R failed (exit code 3)");
      return true;
    });
  });

  it("rejects when age cannot start", async () => {
    const missing = createAge(env, { command: join(fake, "missing-age"), args: [] });
    await assert.rejects(missing.encrypt("ssh-rsa AAAA", "x"), /age -a -R failed/);
  });
});
