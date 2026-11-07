import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Invoke the installed, pinned CLI through Node, including in disposable copies
// where JavaScript files cannot be executed directly by the shell.
const require = createRequire(import.meta.url);
const metadata = require.resolve('astro/package.json');
const { bin } = JSON.parse(await readFile(metadata, 'utf8'));
const entry = join(dirname(metadata), bin.astro);
process.argv[1] = entry;
await import(pathToFileURL(entry));
