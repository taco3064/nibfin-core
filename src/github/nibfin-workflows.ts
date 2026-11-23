/** Every workflow Nibfin installs has a name starting with this prefix. */
export const nibfinWorkflowPrefix = "Nibfin ·";

/** True for a workflow (or workflow run) name that belongs to Nibfin itself. */
export function isNibfinWorkflow(name: string | null | undefined): boolean {
  return typeof name === "string" && name.startsWith(nibfinWorkflowPrefix);
}
