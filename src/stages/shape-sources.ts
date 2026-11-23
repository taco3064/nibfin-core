import {
  type ActingClient,
  commentMarker,
  findMarkedComment,
  type IssueSnapshot,
  readIssueText,
} from "../github/index.ts";
import type { PromptSection } from "./prompt.ts";

/** The comment key of the published Shape. */
export const shapeCommentKey = "shape";

interface IssueSource {
  url: string;
  title: string;
  body: string;
}

interface UpstreamSource extends IssueSource {
  /** The upstream Issue lives in another repository than the workspace. */
  external: boolean;
  /** Its published Shape, if Nibfin wrote one. */
  shape: string | undefined;
}

/** What the Author and the Validator both read: the same sources for each role. */
export interface ShapeSources {
  issue: IssueSource;
  upstream: UpstreamSource[];
}

/** The Shape text of a marked `shape` comment, without the marker line. */
export function shapeOfComment(body: string): string {
  return body.slice(commentMarker(shapeCommentKey).length).trim();
}

export async function readShapeSources(
  client: ActingClient,
  snapshot: IssueSnapshot,
): Promise<ShapeSources> {
  const { issue } = snapshot;
  const text = await readIssueText(client, issue);
  const upstream: UpstreamSource[] = [];
  for (const blocker of snapshot.blockedBy) {
    const blockerText = await readIssueText(client, blocker);
    const comment = await findMarkedComment(client, blocker, shapeCommentKey);
    upstream.push({
      url: blocker.url,
      ...blockerText,
      external: blocker.owner !== issue.owner || blocker.repo !== issue.repo,
      shape: comment === undefined ? undefined : shapeOfComment(comment.body),
    });
  }
  return { issue: { url: issue.url, ...text }, upstream };
}

/** True when the Issue's requirements text differs between two reads. */
export function issueTextChanged(before: ShapeSources, after: ShapeSources): boolean {
  return (
    before.issue.title !== after.issue.title || before.issue.body !== after.issue.body
  );
}

function describeIssue(source: IssueSource): string {
  const body = source.body.trim() === "" ? "(no description)" : source.body;
  return `URL: ${source.url}\nTitle: ${source.title}\n\n${body}`;
}

const externalNote =
  "This Issue is in another repository, so its delivered source is not in the " +
  "workspace. Report a gap instead of guessing its interfaces.";

function upstreamSection(source: UpstreamSource): PromptSection {
  const parts = [describeIssue(source)];
  if (source.external) {
    parts.push(externalNote);
  }
  parts.push(
    `### Its published Shape\n\n${source.shape ?? "(none published by Nibfin)"}`,
  );
  return { title: `Blocked by ${source.url}`, body: parts.join("\n\n") };
}

/** The Issue and its Blocked by Issues as prompt sections. */
export function sourceSections(sources: ShapeSources): PromptSection[] {
  return [
    { title: "Current Issue", body: describeIssue(sources.issue) },
    ...sources.upstream.map(upstreamSection),
  ];
}
