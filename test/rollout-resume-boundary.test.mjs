import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

test('installed completion resumes after self-update, pause and interrupted dispatch', {
  skip: process.platform !== 'linux',
}, () => {
  const script = `
import io
import json
import pathlib
import runpy
import sys
import tempfile

module = runpy.run_path(sys.argv[1])
resume = module['resume_installed_work']
settings = resume.__globals__
calls = []
events = []
exit_status = 0

class Input(io.StringIO):
    def close(self):
        pass

class Process:
    def __init__(self, args, **options):
        assert options['text'] is True
        self.stdin = Input()
        self.stdout = iter(json.dumps(item) + '\\n' for item in events)
        self.code = exit_status
        calls.append(self)
    def wait(self):
        return self.code
    def poll(self):
        return self.code
    def terminate(self):
        raise AssertionError('completed child must not be killed')

settings['subprocess'].Popen = Process
with tempfile.TemporaryDirectory(prefix='.nibfin-rollout-resume-',
                                 dir=pathlib.Path.cwd()) as temp:
    root = pathlib.Path(temp)
    settings['CONFIG'] = root
    settings['INSTALL'] = root / 'install'
    settings['HOSTS'] = {settings['CORE']: 'host.json'}
    entry = settings['INSTALL'] / 'core/src/rollout-resume.mjs'
    entry.parent.mkdir(parents=True)
    entry.write_text('fixture entry; never executed')
    host = dict(sharedRunner={'runner': {}}, installation={'directory': '/core'})
    host_file = root / 'host.json'
    host_file.write_text(json.dumps(host))
    receipt = root / 'rollout-resume.json'

    # First invocation after an old updater replaced itself and removed its plan.
    assert not (root / 'rollout-plan.json').exists()
    settings['RATE_WAIT'] = root / 'rate-wait'
    settings['os'].getuid = lambda: 0
    settings['read_manual_credential'] = lambda hosts: 'synthetic-token'
    settings['next_rollout'] = lambda *args: None
    settings['clean_superseded_staged_packages'] = lambda *args: None
    host['installation']['pin'] = {'commit': 'a' * 40}
    host_file.write_text(json.dumps(host))
    events[:] = [{'status': 'dispatched', 'results': []}]
    module['main']()
    assert json.loads(receipt.read_text())['status'] == 'dispatched'
    module['main']()
    assert len(calls) == 1

    # Losing bookkeeping retries the normal scan rather than blocking startup.
    receipt.unlink()
    events[:] = [{'status': 'paused', 'results': []}]
    resume()
    assert json.loads(receipt.read_text())['status'] == 'paused'
    events[:] = [{'status': 'pending', 'results': []}]
    resume()
    assert json.loads(receipt.read_text())['status'] == 'pending'
    result = dict(repositoryId=1, id='I_1', number=1, runId=60)
    events[:] = [{'dispatched': result}]
    exit_status = 1
    try:
        resume()
        raise AssertionError('interrupted scan falsely completed')
    except RuntimeError:
        pass
    state = json.loads(receipt.read_text())
    assert state['status'] == 'pending' and state['completed'] == [result]
    events[:] = [{'status': 'dispatched', 'results': []}]
    exit_status = 0
    resume()
    assert json.loads(calls[-1].stdin.getvalue())['completed'] == [result]
    assert json.loads(receipt.read_text())['status'] == 'dispatched'

    # A later installed package starts its own completion scan.
    host['installation']['pin'] = {'commit': 'b' * 40}
    host_file.write_text(json.dumps(host))
    resume()
    assert json.loads(calls[-1].stdin.getvalue())['completed'] == []
`;
  const result = spawnSync('python3', ['-B', '-c', script,
    resolve('scripts/host-auto-rollout.py')], { encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});
