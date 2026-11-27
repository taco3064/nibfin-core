import { Eta } from "eta";
import { fileURLToPath } from "node:url";
import { type RenderRequest, templateData } from "./inputs.ts";
import { workflowDir, workflowFiles } from "./sets.ts";

/** Core's own `templates/workflows/`, shipped beside `src/` and `dist/`. */
export const defaultTemplateDir = fileURLToPath(
  new URL("../../templates/workflows/", import.meta.url),
);

/** A template read a value that its set or channel leaves unset. */
export class TemplateValueError extends Error {
  readonly code = "WORKFLOW_TEMPLATE_VALUE_MISSING";
}

/** Every template value is a string; anything else (`undefined`) is unset. */
function requireValue(value: unknown): string {
  if (typeof value !== "string") {
    throw new TemplateValueError("a workflow template read a value that is not set");
  }
  return value;
}

/**
 * The files of the requested set and channel, keyed by their path in the repository
 * (`.github/workflows/<file>`) in sorted order. The same templates and request give
 * the same bytes. Request values only ever reach the templates as data.
 */
export function renderWorkflows(
  request: RenderRequest,
  views: string = defaultTemplateDir,
): Record<string, string> {
  const data = templateData(request);
  const eta = new Eta({
    views,
    autoEscape: false,
    autoTrim: false,
    autoFilter: true,
    filterFunction: requireValue,
  });
  const files: Record<string, string> = {};
  for (const name of workflowFiles(data.set, data.channel)) {
    // Eta adds `.eta` only to a name without an extension.
    files[`${workflowDir}/${name}`] = eta.render(`${name}.eta`, data);
  }
  return files;
}
