import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

test('rollout refreshes current callers after native wake workflow removal', {
  skip: process.platform !== 'linux',
}, () => {
  const script = `
import copy
import runpy
import sys

module = runpy.run_path(sys.argv[1])
configure = module['configure']
settings = configure.__globals__
issue, wake = settings['ISSUE'], settings['WAKE']
binding = dict(repository='owner/core', repositoryId=20, runnerId=25,
               runnerName='existing-runner', memberId=30)
event = dict(binding, workflowPath=issue, workflowId=41,
             sourceCommit='old', workflowBlob='old', reusable={})
legacy = dict(binding, workflowPath=wake, workflowId=42,
              sourceCommit='old', workflowBlob='old')
original = dict(installation={}, repository=dict(
    approval={}, runner=legacy, eventRunner=event,
    eventCaller=dict(reusable={})))
pins = dict(core=dict(commit='core-next'), action=dict(commit='action-next'))
source = dict(commit='core-next')
settings['content'] = lambda repo, path, base: (b'', path + '-blob')
for paths in [(issue, wake), (issue,)]:
    settings['consumer_workflows'] = lambda repo, base: paths
    result = configure('owner/core', copy.deepcopy(original),
                       'main-next', pins, source, 'issue-reusable-blob')
    repo = result['repository']
    assert repo['runner']['workflowId'] == (42 if wake in paths else 41)
    assert repo['runner']['workflowPath'] == (wake if wake in paths else issue)
    assert repo['runner']['runnerId'] == 25
    assert repo['runner']['sourceCommit'] == 'main-next'
    assert repo['runner']['actionCommit'] == 'action-next'
    assert repo['runner']['actionCoreCommit'] == 'core-next'
    assert 'reusable' not in repo['runner']
    assert repo['eventRunner']['reusable']['commit'] == 'core-next'
    assert repo['eventCaller']['reusable']['commit'] == 'core-next'
    assert result['installation']['pin'] == pins['core']
`;
  const result = spawnSync('python3', ['-B', '-c', script,
    resolve('scripts/host-auto-rollout.py')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
