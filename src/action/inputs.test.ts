import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  inputName,
  readCommand,
  readJobFailedInputs,
  readRunnerRequestInputs,
  readWakeInputs,
} from "./inputs.ts";

const env = {
  INPUT_COMMAND: "job-failed",
  INPUT_TOKEN: "secret-token",
  INPUT_REPO: "acme/app",
  INPUT_ISSUE: "7",
  INPUT_STAGE: "deliver",
  GITHUB_REPOSITORY: "acme/runner",
  GITHUB_RUN_ID: "900",
};

function rejects(read: () => unknown, message: string) {
  assert.throws(read, (error: unknown) => {
    const { code } = error as { code?: unknown };
    assert.equal(code, "STAGE_INPUT_INVALID");
    assert.equal((error as Error).message, message);
    assert.ok(!(error as Error).message.includes("secret-token"));
    return true;
  });
}

describe("inputName", () => {
  it("upper-cases the name and keeps hyphens, as the runner does", () => {
    assert.equal(inputName("execution-repo"), "INPUT_EXECUTION-REPO");
    assert.equal(inputName("token"), "INPUT_TOKEN");
  });
});

describe("readCommand", () => {
  it("reads job-failed, runner-request and wake", () => {
    assert.equal(readCommand(env), "job-failed");
    assert.equal(readCommand({ INPUT_COMMAND: "runner-request" }), "runner-request");
    assert.equal(readCommand({ INPUT_COMMAND: "wake" }), "wake");
  });

  it("rejects a missing or unknown command", () => {
    rejects(() => readCommand({}), "INPUT_COMMAND is missing");
    rejects(
      () => readCommand({ INPUT_COMMAND: "deploy" }),
      "INPUT_COMMAND must be one of job-failed, runner-request, wake",
    );
  });
});

describe("readJobFailedInputs", () => {
  it("reads the Issue, the stage, the token and the run URL", () => {
    assert.deepEqual(readJobFailedInputs(env), {
      token: "secret-token",
      issue: { owner: "acme", repo: "app", number: 7 },
      stage: "deliver",
      url: "https://github.com/acme/runner/actions/runs/900",
    });
  });

  const invalid: [string, Record<string, string | undefined>, string][] = [
    ["a missing repo", { INPUT_REPO: undefined }, "INPUT_REPO is missing"],
    ["a bad repo", { INPUT_REPO: "app" }, "INPUT_REPO must be <owner>/<repo>"],
    ["an empty issue", { INPUT_ISSUE: "" }, "INPUT_ISSUE is missing"],
    ["a bad issue", { INPUT_ISSUE: "7a" }, "INPUT_ISSUE must be a positive integer"],
    ["a missing stage", { INPUT_STAGE: " " }, "INPUT_STAGE is missing"],
    ["a bad stage", { INPUT_STAGE: "`x`" }, "INPUT_STAGE must be a stage name"],
    [
      "a missing run repository",
      { GITHUB_REPOSITORY: undefined },
      "GITHUB_REPOSITORY is missing",
    ],
    ["a bad run id", { GITHUB_RUN_ID: "0" }, "GITHUB_RUN_ID must be a positive integer"],
    ["a missing token", { INPUT_TOKEN: "" }, "INPUT_TOKEN is missing"],
  ];
  for (const [name, overrides, message] of invalid) {
    it(`rejects ${name}`, () => {
      rejects(() => readJobFailedInputs({ ...env, ...overrides }), message);
    });
  }
});

describe("readWakeInputs", () => {
  const event = { action: "opened", issue: { number: 7 } };
  const wakeEnv = {
    INPUT_COMMAND: "wake",
    INPUT_TOKEN: "secret-token",
    "INPUT_EXECUTION-REPO": "acme/runner",
    GITHUB_EVENT_NAME: "issues",
    GITHUB_EVENT_PATH: "/runner/event.json",
    GITHUB_REPOSITORY: "acme/app",
    GITHUB_RUN_ID: "900",
  };
  const files = (text: string) => (path: string) => {
    assert.equal(path, "/runner/event.json");
    return text;
  };

  it("reads the event, its repository, the run URL and the inputs as given", () => {
    assert.deepEqual(readWakeInputs(wakeEnv, files(JSON.stringify(event))), {
      eventName: "issues",
      payload: event,
      repo: { owner: "acme", repo: "app" },
      executionRepo: "acme/runner",
      url: "https://github.com/acme/app/actions/runs/900",
      token: "secret-token",
    });
  });

  it("leaves a missing token and execution repository to the wake", () => {
    const env = { ...wakeEnv, INPUT_TOKEN: undefined, "INPUT_EXECUTION-REPO": "" };
    const inputs = readWakeInputs(env, files("{}"));
    assert.equal(inputs.token, undefined);
    assert.equal(inputs.executionRepo, "");
  });

  const invalid: [string, Record<string, string | undefined>, string][] = [
    ["a missing event name", { GITHUB_EVENT_NAME: "" }, "GITHUB_EVENT_NAME is missing"],
    [
      "a missing event path",
      { GITHUB_EVENT_PATH: undefined },
      "GITHUB_EVENT_PATH is missing",
    ],
    [
      "a bad repository",
      { GITHUB_REPOSITORY: "app" },
      "GITHUB_REPOSITORY must be <owner>/<repo>",
    ],
    ["a missing run id", { GITHUB_RUN_ID: "" }, "GITHUB_RUN_ID is missing"],
  ];
  for (const [name, overrides, message] of invalid) {
    it(`rejects ${name}`, () => {
      rejects(() => readWakeInputs({ ...wakeEnv, ...overrides }, files("{}")), message);
    });
  }

  it("rejects an event file that cannot be read", () => {
    const unreadable = () => {
      throw new Error("ENOENT: /runner/event.json");
    };
    rejects(
      () => readWakeInputs(wakeEnv, unreadable),
      "GITHUB_EVENT_PATH cannot be read",
    );
  });

  for (const text of ["not json", "[]", "null", "7"]) {
    it(`rejects the event file ${text}`, () => {
      rejects(
        () => readWakeInputs(wakeEnv, files(text)),
        "GITHUB_EVENT_PATH must be the event's JSON payload",
      );
    });
  }
});

describe("readRunnerRequestInputs", () => {
  const issue = {
    number: 7,
    title: "Nibfin runner request",
    body: "<!-- nibfin:runner-request -->\nssh-key-id: 5",
    user: { login: "ann", type: "User" },
  };
  const requestEnv = {
    INPUT_COMMAND: "runner-request",
    INPUT_TOKEN: "secret-token",
    "INPUT_JOB-TOKEN": "secret-job-token",
    GITHUB_EVENT_NAME: "issues",
    GITHUB_EVENT_PATH: "/runner/event.json",
    GITHUB_REPOSITORY: "acme/app",
    GITHUB_RUN_ID: "900",
  };
  const read = (payload: unknown, env: Record<string, string | undefined> = {}) =>
    readRunnerRequestInputs({ ...requestEnv, ...env }, () => JSON.stringify(payload));

  it("reads the request from the event, the run URL and both tokens", () => {
    assert.deepEqual(read({ action: "opened", issue }), {
      repo: { owner: "acme", repo: "app" },
      issue: {
        number: 7,
        title: "Nibfin runner request",
        body: issue.body,
        login: "ann",
        userType: "User",
      },
      url: "https://github.com/acme/app/actions/runs/900",
      token: "secret-token",
      jobToken: "secret-job-token",
    });
  });

  it("reads an Issue without a body or title text as empty text", () => {
    const inputs = read({ issue: { ...issue, title: "", body: null } });
    assert.equal(inputs.issue.title, "");
    assert.equal(inputs.issue.body, "");
  });

  it("leaves a missing Nibfin token to the request", () => {
    assert.equal(read({ issue }, { INPUT_TOKEN: undefined }).token, undefined);
  });

  it("rejects a missing job token before it reads the event", () => {
    const env = { ...requestEnv, "INPUT_JOB-TOKEN": "" };
    rejects(
      () =>
        readRunnerRequestInputs(env, () => {
          throw new Error("not read");
        }),
      "INPUT_JOB-TOKEN is missing",
    );
  });

  it("rejects another event", () => {
    rejects(
      () => read({ issue }, { GITHUB_EVENT_NAME: "push" }),
      "GITHUB_EVENT_NAME must be issues",
    );
  });

  const invalid: [string, unknown, string][] = [
    ["no issue", {}, "GITHUB_EVENT_PATH has no issue.number"],
    ["a bad number", { issue: { ...issue, number: 0 } }, "has no issue.number"],
    ["a text number", { issue: { ...issue, number: "7" } }, "has no issue.number"],
    ["no title", { issue: { ...issue, title: undefined } }, "has no issue.title"],
    ["a bad body", { issue: { ...issue, body: 5 } }, "has no issue.body"],
    ["no author", { issue: { ...issue, user: null } }, "has no issue.user.login"],
    [
      "an empty author type",
      { issue: { ...issue, user: { login: "ann", type: "" } } },
      "has no issue.user.type",
    ],
  ];
  for (const [name, payload, message] of invalid) {
    it(`rejects an event with ${name}`, () => {
      const full = message.startsWith("GITHUB")
        ? message
        : `GITHUB_EVENT_PATH ${message}`;
      rejects(() => read(payload), full);
    });
  }
});
