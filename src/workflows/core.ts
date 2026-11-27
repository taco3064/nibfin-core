import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RenderRequest } from "./inputs.ts";
import { renderWorkflows } from "./render.ts";
import { workflowDir } from "./sets.ts";

/** The inputs of nibfin-core's own committed workflow files (#775 Decision 10). */
export const coreWorkflowRequest: RenderRequest = {
  set: "execution",
  channel: "own",
  image: "ghcr.io/taco3064/nibfin:main",
  defaultBranch: "main",
  workflows: ["CI", "Image"],
};

/**
 * Writes Core's own rendered workflow files under `root` and returns their paths. It
 * overwrites the rendered names and deletes nothing.
 */
export async function writeCoreWorkflows(root: string): Promise<string[]> {
  const files = renderWorkflows(coreWorkflowRequest);
  await mkdir(join(root, workflowDir), { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    await writeFile(join(root, path), content);
  }
  return Object.keys(files);
}
