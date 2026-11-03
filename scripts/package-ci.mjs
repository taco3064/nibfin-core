import { mkdtemp, mkdir, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packageSource, verifyInstalledSource } from '../src/source-package.mjs';
import { installSource } from '../src/source-install.mjs';
import { command } from '../src/process.mjs';
import { isSha, requireThat } from '../src/identity.mjs';

const commit = process.env.SOURCE_COMMIT;
requireThat(isSha(commit), 'EXACT_PUBLIC_COMMIT_REQUIRED');
const actual = (await command('/usr/bin/git', ['rev-parse', 'HEAD'], { env: { PATH: '/usr/bin:/bin' } })).stdout.toString().trim();
requireThat(actual === commit, 'PACKAGE_CHECKOUT_MISMATCH');
const built = await packageSource(process.cwd(), commit);
const pin = { repository: built.manifest.repository, commit, archiveHash: built.sha256, manifestHash: built.manifestHash };
const temporary = await mkdtemp(join(tmpdir(), 'nibfin-public-install-'));
try {
  const installation = join(temporary, 'core');
  await installSource(built.bytes, installation, pin);
  await verifyInstalledSource(installation, pin);
  // Execute the installed public entry point, not the checkout's copy.
  const result = await command(process.execPath, [join(installation, 'bin/nibfin-core.mjs'), 'help']);
  requireThat(Array.isArray(JSON.parse(result.stdout).commands), 'INSTALLED_ENTRY_UNAVAILABLE');
  const contract = await command(process.execPath, [join(installation, 'bin/nibfin-core.mjs'), 'contract']);
  const actualContract = JSON.parse(contract.stdout);
  requireThat(actualContract.schemaVersion === 1 && actualContract.eventAuthority === false &&
    actualContract.stages.includes('close'), 'INSTALLED_CONTRACT_UNAVAILABLE');
  // Resolve the package export map exactly as an installed thin consumer does.
  await command(process.execPath, ['--input-type=module', '-e',
    "const core = await import('nibfin-core'); if (typeof core.resolveWakeDispatch !== 'function' || typeof core.nativeStageExecutor !== 'function' || typeof core.runStageInput !== 'function' || typeof core.installedStageExecutor !== 'function' || typeof core.codexStageExecutor !== 'function') process.exit(1);"],
  { cwd: installation });
} finally { await rm(temporary, { recursive: true, force: true }); }
await mkdir('distribution', { mode: 0o700 });
await writeFile('distribution/nibfin-core.tar.gz', built.bytes, { flag: 'wx', mode: 0o600 });
await writeFile('distribution/source-pin.json', JSON.stringify(pin, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
await writeFile('distribution/SHA256SUMS', `${built.sha256}  nibfin-core.tar.gz\n`, { flag: 'wx', mode: 0o600 });
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT,
  `archive_sha256=${built.sha256}\nmanifest_hash=${built.manifestHash}\n`);
process.stdout.write(JSON.stringify({ status: 'verified-build', ...pin }) + '\n');
