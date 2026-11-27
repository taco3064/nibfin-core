import { parseArgs } from "node:util";
import { renderWorkflows } from "../workflows/index.ts";
import { type CliIo, printFailure } from "./failure.ts";

/**
 * `nibfin render-workflows`: prints the rendered files of one set and channel as one
 * JSON object, `{ ".github/workflows/<file>": "<content>", … }` with sorted keys. It
 * reads only the templates: no environment, token or network. Invalid input or a
 * template error prints the reason to stderr, nothing to stdout, and exits 1.
 */
export function renderWorkflowsCommand(
  args: readonly string[],
  io: CliIo,
  views?: string,
): number {
  let output: string;
  try {
    const { values } = parseArgs({
      args: [...args],
      options: {
        set: { type: "string", default: "" },
        channel: { type: "string", default: "" },
        image: { type: "string" },
        "default-branch": { type: "string", default: "" },
        workflow: { type: "string", multiple: true, default: [] },
      },
      strict: true,
      allowPositionals: false,
    });
    const request = {
      set: values.set,
      channel: values.channel,
      image: values.image,
      defaultBranch: values["default-branch"],
      workflows: values.workflow,
    };
    output = `${JSON.stringify(renderWorkflows(request, views))}\n`;
  } catch (error) {
    printFailure(io, error);
    return 1;
  }
  io.stdout.write(output);
  return 0;
}
