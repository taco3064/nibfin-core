import test from 'node:test';
import assert from 'node:assert/strict';
import { checkRegistrationEndpoints }
  from '../src/security/shared-runner-start-check.mjs';
import { mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  sharedServiceTemplate, writeSharedServiceTemplate,
} from '../src/shared-service-install.mjs';
import { restoreRolloutServiceTemplate } from '../src/rollout-service-template.mjs';

test('the WSL service includes the reviewed mount restrictions', () => {
  const template = '[Service]\nExecStart=/usr/bin/true\n\n[Install]\n';
  const profile = '[Service]\nInaccessiblePaths=-/run/WSL\n';
  assert.equal(sharedServiceTemplate(template, ''), template);
  assert.equal(sharedServiceTemplate(template, profile),
    '[Service]\nExecStart=/usr/bin/true\nInaccessiblePaths=-/run/WSL\n\n[Install]\n');
});

test('an offline registration may only connect to public GitHub Actions', () => {
  const settings = {
    serverUrl: 'https://pipelinesghubeus11.actions.githubusercontent.com/example/',
    serverUrlV2: 'https://broker.actions.githubusercontent.com/',
    useV2Flow: true,
  };
  const credential = { scheme: 'OAuth', data: { authorizationUrl:
    'https://tokenghub.actions.githubusercontent.com/_apis/oauth2/token/example' } };
  assert.doesNotThrow(() => checkRegistrationEndpoints(settings, credential));
  for (const serverUrl of [
    'https://example.com/',
    'https://pipelinesghubeus11.actions.githubusercontent.com.example.com/example',
    'https://pipelinesghubeus11.actions.githubusercontent.com/example?redirect=elsewhere',
  ]) {
    const changed = { ...settings, serverUrl };
    assert.throws(() => checkRegistrationEndpoints(changed, credential),
      { code: 'UNTRUSTED_SHARED_RUNNER_PROVIDER_ENDPOINT' });
  }
  credential.data.authorizationUrlV2 = 'https://example.com/';
  assert.throws(() => checkRegistrationEndpoints(settings, credential),
    { code: 'UNTRUSTED_SHARED_RUNNER_PROVIDER_ENDPOINT' });
});

test('install shared service template once and refuse changes or links', {
  skip: process.platform !== 'linux',
}, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nibfin-shared-services-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const unit = 'nibfin-shared-runner@.service';
  const path = join(directory, unit);
  const content = '[Service]\nExecStart=/usr/bin/true\n';
  const inspect = actual => assert.equal(actual, path);

  assert.equal(await writeSharedServiceTemplate(directory, content, inspect),
    'installed');
  assert.equal(await writeSharedServiceTemplate(directory, content, inspect),
    'unchanged');
  await assert.rejects(writeSharedServiceTemplate(directory, 'other', inspect),
    { code: 'SHARED_SERVICE_TEMPLATE_CONFLICT' });
  assert.equal(await readFile(path, 'utf8'), content);
  await assert.rejects(writeSharedServiceTemplate(directory, 'new', inspect, 'foreign'),
    { code: 'SHARED_SERVICE_TEMPLATE_CONFLICT' });
  assert.equal(await writeSharedServiceTemplate(directory, 'new', inspect, content),
    'updated');
  assert.equal(await writeSharedServiceTemplate(directory, 'new', inspect, content),
    'unchanged');
  assert.equal(await readFile(path, 'utf8'), 'new');
  await rm(path);
  await symlink('/nonexistent', path);
  await assert.rejects(writeSharedServiceTemplate(directory, content, inspect),
    { code: 'SHARED_SERVICE_TEMPLATE_CONFLICT' });
  assert.deepEqual(await readdir(directory), [unit]);
});

test('stopped-pool restore updates a known unit and resumes after reload failure',
  async () => {
    let actual = 'previous', failReload = true;
    const events = [];
    const ports = {
      read: async () => actual,
      desired: async () => 'current',
      previous: async () => 'previous',
      stopped: async () => { events.push('stopped'); },
      write: async (next, prior) => {
        assert.equal(actual, prior);
        events.push('updated');
        actual = next;
      },
      reload: async () => {
        events.push('reload');
        if (failReload) throw new Error('systemd unavailable');
      },
    };
    await assert.rejects(restoreRolloutServiceTemplate({}, ports), /systemd unavailable/);
    failReload = false;
    await restoreRolloutServiceTemplate({}, ports);
    assert.deepEqual(events, ['stopped', 'updated', 'reload', 'reload']);
    actual = 'operator-customized';
    await assert.rejects(restoreRolloutServiceTemplate({}, ports),
      { code: 'SHARED_SERVICE_TEMPLATE_CONFLICT' });
    assert.equal(actual, 'operator-customized');
    assert.deepEqual(events, ['stopped', 'updated', 'reload', 'reload']);
  });
