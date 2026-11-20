import assert from 'node:assert/strict';
import { chmod, cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { prepareMaintenanceRootIdentity } from './core-maintenance-os-fixture.mjs';

async function inventory(root) {
  const result = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    result.push(path);
    if (entry.isDirectory()) result.push(...await inventory(path));
  }
  return result.sort();
}

// A verified package fixture controls only the report producer. The real fixed
// Python bridge/decoder and dispatcher run as separate production-argv processes.
// Signed admission itself remains covered by the Core maintenance identity suite.
export async function checkMaintenanceTransport(manager, manifest, nodePath) {
  const source = resolve('.');
  const base = '/usr/local/libexec/nibfin/core-rollout';
  const bridge = join(base, 'bridge.py');
  const dispatcher = join(base, 'worker-dispatch.py');
  await cp(join(source, 'scripts/core-maintenance-bridge.py'), bridge);
  await cp(join(source, 'src/security/shared-worker-dispatch.py'), dispatcher);
  await chmod(bridge, 0o755);
  await chmod(dispatcher, 0o755);
  // /etc is a private empty tmpfs. Real sudo needs an OS identity and its
  // normal PAM entry before the test can reach the installed bridge at all.
  await prepareMaintenanceRootIdentity();
  await mkdir('/etc/pam.d');
  await writeFile('/etc/pam.d/sudo', 'auth sufficient pam_rootok.so\n' +
    'account required pam_permit.so\nsession required pam_permit.so\n');
  await writeFile('/etc/sudoers', `root ALL=(root) NOPASSWD: ${bridge} ""\n`,
    { mode: 0o440 });
  const reporter = `
import {spawnSync} from 'node:child_process';
import {admitRolloutManager} from './rollout-manager-context.mjs';
import {writeCommandResult} from './command-result.mjs';
await admitRolloutManager();
let text=''; for await (const bytes of process.stdin) text+=bytes;
const input=JSON.parse(text);
if (input.kind !== 'pre-worker') {
  const peer=spawnSync(${JSON.stringify(bridge)}, [], {
    input: JSON.stringify({...input,kind:'pre-worker'}), encoding:'utf8',
  });
  writeCommandResult(JSON.parse(peer.stdout));
} else {
const frame=JSON.parse(Buffer.from(input.frame,'base64').toString('utf16le'));
if(frame.malformed) { process.stdout.write('secret malformed'); process.exit(0); }
if(frame.mismatch) {
  process.stdout.write(JSON.stringify({status:'admitted'})); process.exit(2);
}
writeCommandResult({...frame.result,token:'secret-token',requestUrl:'secret-url'});
}
`;
  await writeFile(join(manager, 'src/core-maintenance-bridge-entry.mjs'), reporter);
  const pin = await manifest(manager, 'e'.repeat(40));
  await writeFile(join(base, 'source-pin.json'), JSON.stringify(pin));
  await writeFile(join(base, 'runtime.json'), JSON.stringify({ nodePath }));
  const before = await inventory(manager);
  const env = { PATH: process.env.PATH, LANG: 'C',
    PYTHONDONTWRITEBYTECODE: '1', SUDO_UID: '1001' };
  const cases = [
    [{ status: 'pending', code: 'GITHUB_API_ERROR',
      githubApi: { kind: 'http', httpStatus: 422, body: 'secret-body' } }, 2],
    [{ status: 'denied', code: 'CORE_MAINTENANCE_INVOKER_CHANGED' }, 1],
    [{ status: 'pending', code: 'CORE_MANAGEMENT_OPERATION_PENDING' }, 2],
    [{ status: 'admitted' }, 0],
  ];
  for (const [result, expectedExit] of cases) {
    const frame = Buffer.from(JSON.stringify({ result }), 'utf16le');
    const payload = JSON.stringify({ kind: 'pre-worker',
      frame: frame.toString('base64') });
    // The shebang uses -I, so the environment flag cannot hide bytecode writes.
    const executed = spawnSync(bridge, [], { input: payload, encoding: 'utf8', env });
    assert.equal(executed.status, expectedExit, executed.stdout + executed.stderr);
    assert.ok(executed.stdout, executed.stderr);
    const value = JSON.parse(executed.stdout);
    assert.equal(value.status, result.status);
    if (result.githubApi) assert.deepEqual(value.githubApi,
      { kind: 'http', httpStatus: 422 });
    assert.ok(!/secret-/.test(executed.stdout + executed.stderr));
    if (expectedExit) assert.equal(JSON.parse(executed.stderr).code, result.code);
  }
  const ordinary = Buffer.from(JSON.stringify({ result: { status: 'admitted' } }),
    'utf16le').toString('base64');
  for (const [kind, expected] of [['maintenance', 0], ['administrator', 2]]) {
    const executed = spawnSync(bridge, [], { encoding: 'utf8', env,
      input: JSON.stringify({ kind, frame: ordinary }) });
    assert.equal(executed.status, expected, executed.stdout + executed.stderr);
    assert.ok(executed.stdout, executed.stderr);
    const value = JSON.parse(executed.stdout);
    if (expected === 0) assert.equal(value.status, 'admitted');
    else assert.equal(value.code, 'CORE_MANAGEMENT_OPERATION_PENDING');
  }
  for (const flag of ['malformed', 'mismatch']) {
    const frame = Buffer.from(JSON.stringify({ [flag]: true }), 'utf16le');
    const executed = spawnSync(bridge, [], { encoding: 'utf8', env,
      input: JSON.stringify({ kind: 'pre-worker', frame: frame.toString('base64') }) });
    assert.equal(executed.status, 2);
    assert.equal(JSON.parse(executed.stdout).code, 'CORE_ROLLOUT_RESULT_UNAVAILABLE');
    assert.ok(!executed.stderr.includes('secret'));
  }
  const dispatchProbe = [
    'import os,runpy,sys',
    `d=runpy.run_path(${JSON.stringify(dispatcher)})`,
    'r,w=os.pipe();os.write(w,sys.stdin.buffer.read())',
    "sys.stdout.buffer.write(d['admit'](r))",
  ].join(';');
  for (const [result, status] of cases) {
    const body = Buffer.from(JSON.stringify({ result }), 'utf16le');
    const header = Buffer.alloc(8);
    header.writeInt32LE(1); header.writeInt32LE(body.length, 4);
    const frame = Buffer.concat([header, body]);
    const executed = spawnSync('python3', ['-c', dispatchProbe],
      { input: frame, env, encoding: null });
    if (status === 0) {
      assert.equal(executed.status, 0, executed.stderr.toString());
      assert.deepEqual(executed.stdout, frame);
    } else {
      assert.notEqual(executed.status, 0);
      assert.equal(executed.stdout.length, 0);
      assert.ok(executed.stderr.toString().includes(result.code));
      if (result.githubApi) assert.ok(executed.stderr.toString().includes('422'));
      assert.ok(!executed.stderr.toString().includes('secret-'));
    }
  }
  assert.deepEqual(await inventory(manager), before);
  assert.ok(!(await inventory(manager)).some(path => path.includes('__pycache__')));
}
