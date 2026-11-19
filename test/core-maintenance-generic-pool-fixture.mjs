import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readRolloutProcessResult } from '../src/core-rollout-result.mjs';

// All paths were already hidden by the parent fixture's private mount namespace.
export async function checkGenericMaintenancePool(manager, live, node, pin) {
  const hostPath = '/etc/nibfin/host.json';
  const originalHost = JSON.parse(await readFile(hostPath, 'utf8'));
  const bridge = '/usr/local/libexec/nibfin/core-rollout/bridge.py';
  const env = { PATH: '/usr/bin:/bin', LANG: 'C', SUDO_UID: '0' };
  const install = () => spawnSync(node,
    [join(live, 'bin/nibfin-core.mjs'), 'install-core-rollout-manager'],
    { encoding: 'utf8', env });
  const inspect = () => spawnSync(bridge, [], { encoding: 'utf8', env,
    input: JSON.stringify({ kind: 'inspect' }) });
  const paused = '/var/lib/nibfin/notification-relay/control.json';
  await mkdir('/var/lib/nibfin/notification-relay', { recursive: true });
  await writeFile(paused, '{"schemaVersion":1,"paused":true}\n');
  const pauseBefore = await readFile(paused);
  for (const name of ['host.nibfin-act.json', 'host.gh-nibfin.json',
    'host.nibfin-e2e.json']) await rm('/etc/nibfin/' + name);
  const cases = [['example/project'], ['example/project', 'example/other']];
  for (const repositories of cases) {
    const host = structuredClone(originalHost);
    host.sharedRunner.runner.repository = repositories[0];
    host.sharedRunner.caller.repository = repositories[0];
    host.sharedRunner.repositories = repositories.map((_, index) => index + 1);
    host.wakePeerFiles = repositories.length === 1 ? [] : ['/etc/nibfin/host.peer.json'];
    for (const [index, repository] of repositories.entries()) {
      const peer = structuredClone(host);
      peer.repository.approval.repository = repository;
      peer.repository.approval.repositoryId = index + 1;
      peer.repository.runner.repository = repository;
      peer.repository.runner.repositoryId = index + 1;
      peer.repository.eventRunner = { ...peer.repository.runner };
      await writeFile(index ? host.wakePeerFiles[0] : hostPath, JSON.stringify(peer));
    }
    const paths = [];
    for (const slot of [1, 2]) {
      const directory = `/var/lib/nibfin/runners/slot-${slot}`;
      const registration = join(directory, '.runner');
      const local = JSON.parse(await readFile(registration, 'utf8'));
      local.gitHubUrl = `https://github.com/${repositories[0]}`;
      await writeFile(registration, JSON.stringify(local));
      await rm(join(directory, '.nibfin-runner-identity.json'));
      paths.push(registration, join(directory, 'bin/Runner.Listener'),
        join(directory, 'bin/Runner.Worker.official'));
    }
    const before = await Promise.all(paths.map(path => readFile(path)));
    for (const call of [install, inspect, install, inspect]) {
      const result = call();
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(JSON.parse(result.stdout).status, 'installed');
    }
    assert.deepEqual(await Promise.all(paths.map(path => readFile(path))), before);
    assert.deepEqual(await readFile(paused), pauseBefore);
    const promotion = `import{admitRolloutManager}from` +
      `${JSON.stringify('file://' + join(manager, 'src/rollout-manager-context.mjs'))};` +
      `import{bindRolloutPool}from` +
      `${JSON.stringify('file://' + join(manager, 'src/rollout-pool.mjs'))};` +
      `import{readFile}from'node:fs/promises';` +
      `try{await bindRolloutPool(JSON.parse(await readFile(${JSON.stringify(hostPath)},` +
      `'utf8')),await admitRolloutManager());process.exit(1)}` +
      `catch(e){if(e.code!=='ROLLOUT_ENROLLMENTS_CHANGED')throw e;}`;
    const refused = spawnSync(node, ['--input-type=module', '-e', promotion],
      { encoding: 'utf8', env });
    assert.equal(refused.status, 0, refused.stderr);
    const bad = JSON.parse(before[0]);
    bad.agentId = 999;
    await writeFile(paths[0], JSON.stringify(bad));
    let result = install();
    assert.notEqual(result.status, 0);
    assert.equal(JSON.parse(result.stdout).code, 'SHARED_RUNNER_REGISTRATION_MISMATCH');
    await writeFile(paths[0], before[0]);
    await chmod(hostPath, 0o666);
    result = install();
    assert.notEqual(result.status, 0);
    await chmod(hostPath, 0o644);
    const sourcePath = join(live, 'src/identity.mjs');
    const source = await readFile(sourcePath);
    const managerSourcePath = join(manager, 'src/identity.mjs');
    const managerSource = await readFile(managerSourcePath);
    const tampered = Buffer.concat([source, Buffer.from('\n// changed\n')]);
    await writeFile(sourcePath, tampered);
    result = install();
    assert.deepEqual(readRolloutProcessResult(result.stdout, result.stderr,
      result.status), { status: 'denied', code: 'INSTALLED_SOURCE_CHANGED' });
    assert.deepEqual(await readFile(sourcePath), tampered);
    assert.deepEqual(await readFile(managerSourcePath), managerSource);
    await writeFile(sourcePath, source);
    assert.deepEqual(JSON.parse(await readFile(hostPath)).installation.pin, pin);
  }
}
