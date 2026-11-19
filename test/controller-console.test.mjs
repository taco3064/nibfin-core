import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { relayControllerRequest } from '../src/host-relay.mjs';

const setup = new URL('../src/controller-console.mjs', import.meta.url).href;
const refresh = new URL('../src/host-shape-workspace.mjs', import.meta.url).href;

function controllerOutput(guard) {
  const program = [
    ...(guard ? [`await import(${JSON.stringify(setup)});`] : []),
    'console.log("Nibfin Writer backend: firecracker");',
    `const {refreshShapeWorkspace}=await import(${JSON.stringify(refresh)});`,
    'await refreshShapeWorkspace({stage:"shape",receipts:{},openPr:null,',
    'workspace:{comparisonBase:async()=>"old",refreshForShape:async()=>{}},',
    'observeMain:async()=>({head:"new"}),settle:async()=>{}});',
    'process.stdout.write(JSON.stringify({schemaVersion:1,stage:"continue",',
    'status:"denied",code:"STAGE_REQUIRES_CORRECTION",terminalStage:"deliver"})',
    '+"\\n");',
  ].join('\n');
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', program],
    { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result;
}

test('Controller diagnostics cannot corrupt or conceal its actual stage result',
  async () => {
    const old = controllerOutput(false);
    assert.throws(() => JSON.parse(old.stdout));
    const fixed = controllerOutput(true);
    assert.equal(fixed.stdout.trim().split('\n').length, 1);
    assert.match(fixed.stderr, /Nibfin Writer backend: firecracker/);
    assert.match(fixed.stderr, /Nibfin Shape workspace updated/);
    let invocations = 0;
    const result = await relayControllerRequest({ command: 'stage', stage: 'continue' },
      999, async () => { invocations++; return { stdout: Buffer.from(fixed.stdout) }; });
    assert.equal(invocations, 1);
    assert.equal(result.code, 'STAGE_REQUIRES_CORRECTION');
    assert.equal(result.terminalStage, 'deliver');
  });

test('a genuinely malformed reply remains unresolved instead of selecting a JSON tail',
  async () => {
    const reply = controllerOutput(false);
    const result = await relayControllerRequest({ command: 'stage', stage: 'continue' },
      999, async () => ({ stdout: Buffer.from(reply.stdout) }));
    assert.equal(result.code, 'CONTROLLER_HANDOFF_UNRESOLVED');
    assert.equal(result.initialFailure, 'RESPONSE_INVALID');
  });
