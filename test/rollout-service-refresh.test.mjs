import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

test('installed lifecycle refreshes the verified failure retry unit and script', () => {
  const script = `
import json, pathlib, runpy, sys, tempfile
module = runpy.run_path(sys.argv[1])
refresh = module['refresh_rollout_service']
g = refresh.__globals__
with tempfile.TemporaryDirectory(dir=pathlib.Path.cwd()) as directory:
    root = pathlib.Path(directory)
    installed = root / 'install'
    scripts = installed / 'core/scripts'
    scripts.mkdir(parents=True)
    source = scripts / 'host-auto-rollout.py'
    template = scripts / 'nibfin-rollout.service'
    source.write_bytes(b'new coordinator')
    template.write_bytes(b'[Service]\\nType=oneshot\\nRestart=on-failure\\n')
    service = root / 'host-auto-rollout.py'
    service.write_bytes(b'old coordinator')
    unit = root / 'nibfin-rollout.service'
    unit.write_bytes(b'[Service]\\nType=oneshot\\n')
    g.update(INSTALL=installed, SERVICE_SCRIPT=service, __file__=str(service))
    g['Path'] = lambda value: (unit if value ==
        '/etc/systemd/system/nibfin-rollout.service' else pathlib.Path(value))
    calls = []
    def run(*args):
        calls.append(args)
        if args[0] == 'node':
            assert args[2] == 'verify'
            assert json.loads(pathlib.Path(args[-1]).read_text()) == {'commit': 'pin'}
    g['run'] = run
    host = {'installation': {'pin': {'commit': 'pin'}}}
    refresh(host)
    assert source.read_bytes() == service.read_bytes()
    assert template.read_bytes() == unit.read_bytes()
    assert service.stat().st_mode & 0o777 == 0o755
    assert unit.stat().st_mode & 0o777 == 0o644
    assert len(calls) == 2 and calls[-1] == ('systemctl', 'daemon-reload')
    refresh(host)
    assert len(calls) == 2
    unit.write_bytes(b'old unit')
    def fail(*args):
        raise RuntimeError('verification failed')
    g['run'] = fail
    try:
        refresh(host)
        raise AssertionError('unverified service update accepted')
    except RuntimeError as error:
        assert str(error) == 'verification failed'
    assert unit.read_bytes() == b'old unit'
`;
  const result = spawnSync('python3', ['-B', '-c', script,
    resolve('scripts/host-auto-rollout.py')], { encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});
