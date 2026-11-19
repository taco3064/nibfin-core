import { Console } from 'node:console';

// The Controller's stdout carries exactly one result. Library diagnostics,
// including future console.log calls, belong to stderr instead.
globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr });
