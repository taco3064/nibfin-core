import {
  type WorkflowChannel,
  workflowChannels,
  type WorkflowSet,
  workflowSets,
} from "./sets.ts";

/** The repository of the Nibfin image, the only one the templates run. */
export const imageRepository = "ghcr.io/taco3064/nibfin";

/** What a render is asked for, as given (for example on the command line). */
export interface RenderRequest {
  set: string;
  channel: string;
  /** Required for the execution set; checked for its channel when given. */
  image?: string;
  defaultBranch: string;
  /** The repository's CI/CD workflow names; none leaves out `workflow_run`. */
  workflows: readonly string[];
}

/**
 * The `it` object of the templates. A value a set or channel does not use is
 * `undefined`, so a template that reads it fails instead of printing it.
 */
export interface TemplateData {
  set: WorkflowSet;
  channel: WorkflowChannel;
  imageRepository: string;
  /** User channel: `<imageRepository>@sha256:<digest>`. */
  imageRef: string | undefined;
  /** Own channel: the tag the Jobs pull, such as `main`. */
  imageTag: string | undefined;
  /** The default branch as a YAML flow sequence. */
  branches: string;
  /** The workflow names as a YAML flow sequence, or "" when there are none. */
  workflows: string;
  /** The token expression of the events job. */
  eventsToken: string;
  /** Own channel: what `nibfin-issue.yml` calls for its events job. */
  eventsUses: string | undefined;
}

/** A render input that is missing or not allowed. */
export class WorkflowInputError extends Error {
  readonly code = "WORKFLOW_INPUT_INVALID";
}

const repositoryPattern = imageRepository.replaceAll(".", "\\.");
const digestImage = new RegExp(`^${repositoryPattern}@sha256:[0-9a-f]{64}$`);
// Docker's tag grammar, [\w][\w.-]{0,127} (distribution/reference).
const tagImage = new RegExp(`^${repositoryPattern}:([A-Za-z0-9_][A-Za-z0-9_.-]{0,127})$`);
// Go's unicode.IsControl and strings.TrimSpace, as gh-nibfin checks them.
const control = /\p{Cc}/u;
const blank = /^\p{White_Space}*$/u;

function oneOf<T extends string>(name: string, value: string, allowed: readonly T[]): T {
  if (!(allowed as readonly string[]).includes(value)) {
    const list = allowed.join(" or ");
    throw new WorkflowInputError(`${name} ${JSON.stringify(value)} is not ${list}`);
  }
  return value as T;
}

function readImage(request: RenderRequest, set: WorkflowSet, channel: WorkflowChannel) {
  const { image } = request;
  if (image === undefined) {
    if (set === "execution") {
      throw new WorkflowInputError("the execution set needs an image");
    }
    return { imageRef: undefined, imageTag: undefined };
  }
  if (channel === "user") {
    if (!digestImage.test(image)) {
      const want = `${imageRepository}@sha256:<digest>`;
      throw new WorkflowInputError(`image ${JSON.stringify(image)} is not ${want}`);
    }
    return { imageRef: image, imageTag: undefined };
  }
  const tag = tagImage.exec(image)?.[1];
  if (tag === undefined) {
    const want = `${imageRepository}:<tag>`;
    throw new WorkflowInputError(`image ${JSON.stringify(image)} is not ${want}`);
  }
  return { imageRef: undefined, imageTag: tag };
}

function readBranch(branch: string): string {
  if (branch === "" || /["']/.test(branch) || control.test(branch)) {
    const quoted = JSON.stringify(branch);
    throw new WorkflowInputError(
      `default branch ${quoted} is empty or has a quote or control character`,
    );
  }
  return branch;
}

function compareUtf8(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

/** Non-blank, control-free names, deduplicated and sorted by their UTF-8 bytes. */
function readWorkflows(names: readonly string[]): string[] {
  for (const name of names) {
    if (blank.test(name) || control.test(name)) {
      const quoted = JSON.stringify(name);
      throw new WorkflowInputError(
        `workflow name ${quoted} is empty or has a control character`,
      );
    }
  }
  return [...new Set(names)].sort(compareUtf8);
}

/**
 * One JSON-quoted string, a valid YAML double-quoted scalar. U+2028 and U+2029 are
 * escaped as Go's encoding/json does, so gh-nibfin's output stays byte for byte.
 */
function quote(value: string): string {
  return JSON.stringify(value)
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

/** Items as a YAML flow sequence of JSON-quoted strings. */
export function flow(items: readonly string[]): string {
  return `[${items.map(quote).join(", ")}]`;
}

const eventsUses: Record<WorkflowSet, string> = {
  execution: "./.github/workflows/nibfin-events.yml",
  peer: "taco3064/nibfin-core/.github/workflows/nibfin-events.yml@main",
};

/** Validates a request and builds the templates' data (#775 Decision 9). */
export function templateData(request: RenderRequest): TemplateData {
  const set = oneOf("set", request.set, workflowSets);
  const channel = oneOf("channel", request.channel, workflowChannels);
  const image = readImage(request, set, channel);
  const branches = flow([readBranch(request.defaultBranch)]);
  const names = readWorkflows(request.workflows);
  const own = channel === "own";
  return {
    set,
    channel,
    imageRepository,
    ...image,
    branches,
    workflows: names.length === 0 ? "" : flow(names),
    eventsToken: own ? "${{ secrets.token }}" : "${{ secrets.NIBFIN_GITHUB_TOKEN }}",
    eventsUses: own ? eventsUses[set] : undefined,
  };
}
