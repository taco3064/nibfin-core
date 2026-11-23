import {
  type ActingClient,
  findMarkedComment,
  type IssueRef,
  readIssueText,
} from "../github/index.ts";
import { fenced, type PromptSection } from "./prompt.ts";
import { shapeCommentKey, shapeOfComment } from "./shape-sources.ts";

/** The requirements both roles read, re-read for every run so the current text wins. */
export interface DeliverSources {
  issueUrl: string;
  title: string;
  body: string;
  /** The approved Shape: the marked `shape` comment without its marker. */
  shape: string;
}

/** The current sources; `undefined` when the Issue has no marked Shape comment. */
export async function readDeliverSources(
  client: ActingClient,
  issue: IssueRef,
  issueUrl: string,
): Promise<DeliverSources | undefined> {
  const text = await readIssueText(client, issue);
  const comment = await findMarkedComment(client, issue, shapeCommentKey);
  if (comment === undefined) {
    return undefined;
  }
  return { issueUrl, ...text, shape: shapeOfComment(comment.body) };
}

function sourceSections(sources: DeliverSources): PromptSection[] {
  const body = sources.body.trim() === "" ? "(no description)" : sources.body;
  return [
    {
      title: "Current Issue",
      body: `URL: ${sources.issueUrl}\nTitle: ${sources.title}\n\n${body}`,
    },
    { title: "Approved Shape", body: sources.shape },
  ];
}

export interface WriterInput {
  sources: DeliverSources;
  issue: number;
  base: string;
  branch: string;
  /** The open pull request of the branch; then pushes wait for Accept. */
  openPullUrl: string | undefined;
  fix: string | undefined;
  /** Findings to fix from the previous round. */
  defects: readonly string[] | undefined;
}

function branchText(input: WriterInput): string {
  const { base, branch } = input;
  const pushes =
    input.openPullUrl === undefined
      ? "The stage pushes each new commit as it appears and once more when you return."
      : `The branch has an open pull request (${input.openPullUrl}); the stage ` +
        "pushes only after a fresh Accept passes.";
  return [
    `Work on branch \`${branch}\`, which is checked out. The base branch is ` +
      `\`${base}\`; \`origin/${base}\` is its latest fetched head. When the branch ` +
      `is behind \`origin/${base}\`, rebase it onto \`origin/${base}\`.`,
    "Commit in coherent stages and leave no uncommitted changes. Do not push: the " +
      `stage holds the only credentials and pushes for you. ${pushes}`,
    `Never put a closing keyword for #${input.issue} (such as \`Closes #` +
      `${input.issue}\`) in a commit message: the Issue closes only after CD.`,
  ].join("\n\n");
}

function list(items: readonly string[]): string {
  return items.map((item) => `- ${item}`).join("\n");
}

export function writerSections(input: WriterInput): PromptSection[] {
  const task =
    input.defects !== undefined
      ? "Fix every defect below within the approved Shape, then return your result."
      : input.fix !== undefined
        ? "Fix what the fix reason below points at, within the approved Shape."
        : "Implement the approved Shape for the current Issue.";
  const sections: PromptSection[] = [
    { title: "Task", body: task },
    ...sourceSections(input.sources),
    { title: "Branch", body: branchText(input) },
  ];
  if (input.fix !== undefined) {
    sections.push({ title: "Fix reason", body: input.fix });
  }
  if (input.defects !== undefined) {
    sections.push({ title: "Defects", body: list(input.defects) });
  }
  return sections;
}

export interface AcceptorInput {
  sources: DeliverSources;
  base: string;
  diff: string;
  fix: string | undefined;
}

export function acceptorSections(input: AcceptorInput): PromptSection[] {
  const sections: PromptSection[] = [
    {
      title: "Task",
      body: "Check the branch independently against the current Issue and its Shape.",
    },
    ...sourceSections(input.sources),
    {
      title: `Branch diff against origin/${input.base}`,
      body: fenced(input.diff, "diff"),
    },
  ];
  if (input.fix !== undefined) {
    sections.push({ title: "Fix reason", body: input.fix });
  }
  return sections;
}
