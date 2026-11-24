// Shared test support for the stages: a stateful fake Issue behind the fake GitHub
// API, fake stage dependencies and a Git workspace. It holds no tests of its own.
import { execFileSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { makeTempDir } from "../agent/fake-cli.test.ts";
import type { RunAgentOptions } from "../agent/index.ts";
import type { NibfinConfig } from "../config/index.ts";
import {
  type FakeGitHub,
  type FakeRequest,
  fakeActor,
  fakeGitHub,
  fakeToken,
  paged,
} from "../github/fake-github.test.ts";
import { issue as issueJson } from "../github/fixtures.test.ts";
import type { StageDeps } from "./agent.ts";
import type { JobContext } from "./context.ts";
import { resultFence } from "./result.ts";

export interface FakeComment {
  id: number;
  userId: number;
  body: string;
  /** Body versions: 1 until an update changes the body (GitHub's edit history). */
  versions?: number;
}

export interface FakeIssue {
  owner: string;
  repo: string;
  number: number;
  state: "open" | "closed";
  labels: string[];
  assignees: Array<{ id: number; login: string }>;
  title: string;
  body: string | null;
  comments: FakeComment[];
}

export function fakeIssue(overrides: Partial<FakeIssue> = {}): FakeIssue {
  return {
    owner: "acme",
    repo: "app",
    number: 1,
    state: "open",
    labels: ["scope"],
    assignees: [{ id: 5, login: "taco" }],
    title: "Add the widget",
    body: "The widget must exist.",
    comments: [],
    ...overrides,
  };
}

const issueUrl = (issue: FakeIssue) =>
  `https://github.com/${issue.owner}/${issue.repo}/issues/${issue.number}`;

function commentJson(issue: FakeIssue, comment: FakeComment) {
  return {
    id: comment.id,
    user: { id: comment.userId, login: `user-${comment.userId}` },
    body: comment.body,
    html_url: `${issueUrl(issue)}#issuecomment-${comment.id}`,
    // Fake-only: GraphQL `userContentEdits.totalCount` for the Issue record.
    edits: (comment.versions ?? 1) === 1 ? 0 : comment.versions,
  };
}

function issueData(issue: FakeIssue, blockedBy: number) {
  return {
    ...issueJson(issue.number, {
      owner: issue.owner,
      repo: issue.repo,
      state: issue.state,
      labels: issue.labels,
      assignees: issue.assignees,
      totalBlockedBy: blockedBy,
    }),
    title: issue.title,
    body: issue.body,
  };
}

export interface FakeIssues {
  github: FakeGitHub;
  main: FakeIssue;
  blockers: FakeIssue[];
  /** Comments written by the actor on the main Issue, by marker key. */
  marked(key: string): FakeComment[];
}

let nextCommentId = 1000;

/** Adds a comment to `issue` and the route that updates it in place. */
function addComment(github: FakeGitHub, issue: FakeIssue, userId: number, body: string) {
  const comment = { id: nextCommentId++, userId, body, versions: 1 };
  issue.comments.push(comment);
  const path = `/repos/${issue.owner}/${issue.repo}/issues/comments/${comment.id}`;
  github.routes.set(`PATCH ${path}`, (request: FakeRequest) => {
    const next = (request.body as { body: string }).body;
    comment.versions += next === comment.body ? 0 : 1;
    comment.body = next;
    return { data: commentJson(issue, comment) };
  });
  github.routes.set(`GET ${path}`, () => ({
    data: { id: comment.id, node_id: `IC_${comment.id}` },
  }));
  return comment;
}

/**
 * Answers a GraphQL query on an Issue comment node (`IC_<id>`) of `issues`: its body
 * and `userContentEdits.totalCount` (0 for a comment never edited, else its versions).
 */
export function answerCommentQuery(issues: FakeIssue[], request: FakeRequest) {
  const { variables } = request.body as { variables: { id: string } };
  const id = Number(variables.id.slice("IC_".length));
  const comment = issues
    .flatMap((issue) => issue.comments)
    .find((candidate) => candidate.id === id);
  if (comment === undefined) {
    return { data: { data: { node: null } } };
  }
  const versions = comment.versions ?? 1;
  const totalCount = versions === 1 ? 0 : versions;
  return {
    data: { data: { node: { body: comment.body, userContentEdits: { totalCount } } } },
  };
}

/** Routes an Issue: itself, its Blocked by list, comments and labels. */
export function routeIssue(github: FakeGitHub, issue: FakeIssue, blockers: FakeIssue[]) {
  const base = `/repos/${issue.owner}/${issue.repo}/issues/${issue.number}`;
  const labelsJson = () => issue.labels.map((name) => ({ name }));
  github.routes.set(`GET ${base}`, () => ({ data: issueData(issue, blockers.length) }));
  github.routes.set(`GET ${base}/dependencies/blocked_by`, (request) =>
    paged(blockers.map((blocker) => issueData(blocker, 0)))(request),
  );
  github.routes.set(`GET ${base}/comments`, (request) =>
    paged(issue.comments.map((comment) => commentJson(issue, comment)))(request),
  );
  github.routes.set(`POST ${base}/comments`, (request) => {
    const { body } = request.body as { body: string };
    const comment = addComment(github, issue, fakeActor.id, body);
    return { status: 201, data: commentJson(issue, comment) };
  });
  github.routes.set(`GET ${base}/labels`, (request) => paged(labelsJson())(request));
  github.routes.set(`POST ${base}/labels`, (request) => {
    const { labels } = request.body as { labels: string[] };
    issue.labels.push(...labels.filter((label) => !issue.labels.includes(label)));
    return { data: labelsJson() };
  });
  for (const name of ["scope", "shaped", "delivered", "pause"]) {
    github.routes.set(`DELETE ${base}/labels/${name}`, () => {
      if (!issue.labels.includes(name)) {
        return { status: 404, data: { message: "Label does not exist" } };
      }
      issue.labels.splice(issue.labels.indexOf(name), 1);
      return { data: labelsJson() };
    });
  }
}

/** A fake GitHub holding `main` (acme/app#1) and the Issues it is blocked by. */
export function fakeIssues(main: FakeIssue, blockers: FakeIssue[] = []): FakeIssues {
  const github = fakeGitHub({
    "GET /repos/acme/app/pulls": paged([]),
  });
  routeIssue(github, main, blockers);
  for (const blocker of blockers) {
    routeIssue(github, blocker, []);
  }
  github.routes.set("POST /graphql", (request) =>
    answerCommentQuery([main, ...blockers], request),
  );
  return {
    github,
    main,
    blockers,
    marked: (key) =>
      main.comments.filter(
        (comment) =>
          comment.userId === fakeActor.id &&
          comment.body.startsWith(`<!-- nibfin:${key} -->`),
      ),
  };
}

/** Seeds a comment written by `userId` (the actor by default). */
export function seedComment(
  issues: FakeIssues,
  issue: FakeIssue,
  body: string,
  userId = fakeActor.id,
): FakeComment {
  return addComment(issues.github, issue, userId, body);
}

/** The version `<id>.<versions>` of a comment, as the stages compute it. */
export function commentVersion(comment: FakeComment): string {
  return `${comment.id}.${comment.versions ?? 1}`;
}

/** The current version of the main Issue's marked Shape comment. */
export function shapeVersion(issues: FakeIssues): string {
  return commentVersion(issues.marked("shape")[0]);
}

/** An owner edit of the main Issue's Shape: the body changes, a new version. */
export function editShape(issues: FakeIssues, text: string): void {
  const comment = issues.marked("shape")[0];
  comment.body = `<!-- nibfin:shape -->\n${text}`;
  comment.versions = (comment.versions ?? 1) + 1;
}

/** A final message ending with a `nibfin-result` block of `value`. */
export function agentResult(value: unknown): string {
  return `Done.\n${resultFence}\n${JSON.stringify(value, null, 2)}\n\`\`\`\n`;
}

/** One scripted agent run: its final message, an error, or a function of the run. */
export type AgentStep =
  string | Error | ((options: RunAgentOptions) => string | Promise<string>);

export interface FakeDeps {
  deps: StageDeps;
  logs: string[];
  runs: RunAgentOptions[];
  configReads: string[];
  toolPreparations: Array<{ tools: NibfinConfig["tools"]; cacheDir: string }>;
  skillReads: string[];
}

export const fakePathEntries = ["/cache/node/22.15.0/bin"];

export function fakeDeps(steps: AgentStep[], config?: NibfinConfig): FakeDeps {
  const fake: Omit<FakeDeps, "deps"> = {
    logs: [],
    runs: [],
    configReads: [],
    toolPreparations: [],
    skillReads: [],
  };
  const deps: StageDeps = {
    runAgent: async (options) => {
      // Like runAgent: the hook runs right before the CLI would start.
      await options.beforeStart?.();
      fake.runs.push(options);
      const step = steps.shift();
      if (step === undefined) {
        throw new Error("No agent run was scripted");
      }
      if (step instanceof Error) {
        throw step;
      }
      const finalMessage = typeof step === "string" ? step : await step(options);
      return { exitCode: 0, finalMessage };
    },
    readNibfinConfig: (workspace) => {
      fake.configReads.push(workspace);
      return Promise.resolve(config ?? { tools: { node: "22.15.0" }, skills: {} });
    },
    resolveRoleSkill: (role) => {
      fake.skillReads.push(role);
      return Promise.resolve(`SKILL TEXT OF ${role}`);
    },
    readMeminfo: () => Promise.resolve("MemAvailable:   8388608 kB\n"),
    prepareTools: (tools, options) => {
      fake.toolPreparations.push({ tools, cacheDir: options.cacheDir });
      return Promise.resolve([...fakePathEntries]);
    },
    log: (line) => fake.logs.push(line),
  };
  return { ...fake, deps };
}

/** A Git repository with one commit, under the ignored `.test-tmp/`. */
export async function makeCommittedWorkspace(prefix: string): Promise<string> {
  const parent = await makeTempDir(prefix);
  const workspace = await mkdtemp(join(parent, "workspace-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: workspace, stdio: "ignore" });
  git("init", "--quiet");
  git(
    "-c",
    "user.name=Nibfin Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "--quiet",
    "--allow-empty",
    "-m",
    "init",
  );
  return workspace;
}

export function jobContext(workspace: string, model?: string): JobContext {
  return {
    repo: { owner: "acme", repo: "app" },
    issue: 1,
    provider: "claude",
    ...(model === undefined ? {} : { model }),
    token: fakeToken,
    agentHome: "/login/claude",
    workspace,
    toolCache: "/cache",
  };
}
