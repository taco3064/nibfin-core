import { readVersion } from "./version.ts";

export interface OutputStream {
  write(text: string): unknown;
}

export interface CliIo {
  stdout: OutputStream;
  stderr: OutputStream;
}

export const usage = `Usage: nibfin <option>

Options:
  --help     Show this help
  --version  Print the nibfin version
`;

export function run(args: readonly string[], io: CliIo): number {
  const option = args.length === 1 ? args[0] : undefined;
  if (option === "--version") {
    io.stdout.write(`${readVersion()}\n`);
    return 0;
  }
  if (option === "--help") {
    io.stdout.write(usage);
    return 0;
  }
  io.stderr.write(usage);
  return 1;
}
