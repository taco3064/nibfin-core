// `npm run render:workflows`: renders Core's own workflow files into the current
// directory's .github/workflows/ (the repository root when run through npm).
import { writeCoreWorkflows } from "./core.ts";

for (const path of await writeCoreWorkflows(process.cwd())) {
  process.stdout.write(`Wrote ${path}\n`);
}
