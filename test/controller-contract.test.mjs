import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import {
  controllerRoute,
  controllerRunnerUids,
  validateControllerRequest,
  readControllerInput,
} from '../src/controller-contract.mjs';

const host = {
  uid: 999,
  runnerUid: 997,
  issues: { 2: { isolation: { kind: 'linux-rootful-docker-v1' } } },
};
const request = {
  schemaVersion: 1,
  command: 'stage',
  issue: '2',
  stage: 'continue',
  context: {
    GITHUB_REPOSITORY: 'owner/repo',
    GITHUB_RUN_ID: '1',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    RUNNER_ENVIRONMENT: 'self-hosted',
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://example.invalid',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'synthetic-not-an-oidc-grant',
  },
};

test('rootful requires distinct small Runner/controller UIDs and one backend', () => {
  assert.equal(controllerRoute(host), true);
  assert.equal(controllerRoute({ uid: 1000 }), false);
  for (const changed of [
    { uid: 0 },
    { runnerUid: 0 },
    { uid: 997 },
    { runnerUid: undefined },
    { uid: 231072 },
    { issues: {} },
    { issues: { 2: { isolation: { kind: 'linux-rootless-docker-v1' } } } },
  ]) {
    assert.throws(() => controllerRoute({ ...host, ...changed }));
  }
});

test('a second shared Runner must have a distinct unprivileged UID', () => {
  const second = uid => ({ ...host, sharedRunner: { additionalRunner: { uid } } });
  assert.equal(controllerRoute(second(996)), true);
  assert.deepEqual(controllerRunnerUids(second(996)), [997, 996]);
  for (const uid of [0, 997, 999, 65536, undefined]) {
    assert.throws(() => controllerRoute(second(uid)), /INVALID_CONTROLLER_SEPARATION/);
  }
});

test('transport cannot select commands, host files, policy or extra environment', () => {
  assert.equal(validateControllerRequest(request), request);
  for (const changed of [
    { executable: '/bin/sh' },
    { socket: '/var/run/docker.sock' },
    { command: 'install' },
    { issue: '../../auth' },
    { stage: 'shape; cat /auth' },
    { context: { ...request.context, NODE_OPTIONS: '--import=/tmp/evil.mjs' } },
    { context: { ...request.context, GITHUB_EVENT_PATH: '/private/auth.json' } },
  ]) {
    assert.throws(() => validateControllerRequest({ ...request, ...changed }));
  }
  const event = { ...request, command: 'dispatch-event', event: '{"issue":{}}' };
  delete event.stage;
  assert.equal(validateControllerRequest(event), event);
  assert.throws(() =>
    validateControllerRequest({ ...event, event: 'x'.repeat(1048577) }),
  );
});

test('bounded transport does not authenticate native identity', async () => {
  const parsed = await readControllerInput(
    Readable.from([Buffer.from(JSON.stringify(request))]),
  );
  assert.deepEqual(parsed, request);
  assert.equal(Object.hasOwn(parsed, 'authorized'), false);
  await assert.rejects(
    readControllerInput(Readable.from([Buffer.alloc(2 * 1048576 + 1)])),
    /CONTROLLER_REQUEST_TOO_LARGE/,
  );
});
