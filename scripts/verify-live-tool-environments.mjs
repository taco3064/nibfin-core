// Native Docker verification: no production login, inference or job admission.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ToolEnvironmentPreparer, ToolPreparationError,
} from '../src/tool-environment.mjs';
import { preparationRecipe } from '../src/tool-recipe.mjs';
import { toolCatalog } from '../src/tool-catalog.mjs';
import { OfflineSandbox } from '../src/sandbox.mjs';
import { pathToFileURL } from 'node:url';
import { verifyLiveAdapter } from './live-adapter-probe.mjs';
import { liveDockerProfile } from './live-docker-profile.mjs';

export async function verifyLiveToolEnvironments(probe = probeToolEnvironments) {
  try { await probe(); }
  catch (error) {
    // CI recovery forwards plain Error codes, not custom error message text.
    if (error instanceof ToolPreparationError &&
      error.code === 'TOOL_PREPARATION_FAILED')
      throw new Error(error.diagnosticCode);
    throw error;
  }
}

async function probeToolEnvironments() {
  const { backend, socket } = liveDockerProfile();
  const config = { docker: '/usr/bin/docker', socket };
  const preparer = new ToolEnvironmentPreparer(config, { backend });
  const [node22, node24] = toolCatalog.node;
  const python = toolCatalog.python[0], go = toolCatalog.go[0];
  assert.equal(await preparer.prepare(), null);
  assert.equal(await preparer.prepare({}), null);
  const first = await preparer.prepare({ node: node22 });
  const second = await preparer.prepare({ node: node24 });
  assert.notEqual(first, second);
  assert.equal(await preparer.prepare({ node: node22 }), first);
  assert.equal(await preparer.prepare({ node: node24 }), second);
  const tools = { node: node22, python, go };
  const combination = await preparer.prepare(tools);
  assert.equal(await preparer.prepare({ go, python, node: node22 }), combination);
  const root = await mkdtemp(join(tmpdir(), 'nibfin-live-tools-'));
  try {
    const work = join(root, 'work'), baseline = join(root, 'baseline');
    await mkdir(work);
    await mkdir(baseline);
    for (const [image, node, combined] of [
      [first, node22, false], [second, node24, false], [combination, node22, true],
    ]) {
      const sandbox = new OfflineSandbox({ ...config, image }, { backend });
      const { versions } = await preparationRecipe({ node });
      const script = [
        'set -eu',
        `test "$(node --version)" = v${node}`,
        `test "$(/usr/local/bin/node --version)" = v${versions.node}`,
        `test "$(PATH=/usr/local/bin:/usr/bin:/bin codex --version)" = ` +
          `'${versions.codex}'`,
        'npm --version >/dev/null',
        ...(combined ? [
          `test "$(python3 --version)" = 'Python ${python}'`,
          "python3 -c 'import ssl, sqlite3, bz2, lzma, ctypes'",
          'pip --version >/dev/null',
          `test "$(go env GOVERSION)" = go${go}`,
          'test "$(go env GOTOOLCHAIN)" = local',
        ] : []),
        'test ! -e /var/run/docker.sock',
        `test ! -e '${socket}'`,
        'test ! -e /auth/auth.json',
        'test ! -e /agent-home/auth.json',
        "node -e 'const n=require(\"node:net\");" +
          'const s=n.connect({host:"1.1.1.1",port:443});' +
          's.on("connect",()=>process.exit(9));' +
          's.on("error",()=>process.exit(0));' +
          "setTimeout(()=>{s.destroy();process.exit(0)},1500)'",
      ].join('\n');
      const result = await sandbox.execute({ work, baseline, script });
      assert.equal(result.status, 'passed', JSON.stringify(result));
    }
    // The existing adapter diagnostic runs the actual bootstrap and denial probe,
    // then stops at the missing synthetic login, without invoking a model.
    await verifyLiveAdapter(combination);
    // Preparation failures cannot invalidate either previously usable environment.
    await assert.rejects(preparer.prepare({ node: '0.0.0' }), /Unsupported/);
    assert.equal(await preparer.prepare({ node: node22 }), first);
    assert.equal(await preparer.prepare({ node: node24 }), second);
    console.log(JSON.stringify({ kind: 'real-tool-environments', status: 'passed',
      first, second, combination, reuse: true, coexistence: true,
      offlineHooksVerified: true, bootstrapSeparationVerified: true,
      adapterDenialVerified: true, authenticatedAgentVerified: false }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await verifyLiveToolEnvironments();
