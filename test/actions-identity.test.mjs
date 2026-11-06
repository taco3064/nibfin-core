import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import {
  verifyActionsIdentity,
  requestActionsIdentity,
  actionsCaller,
} from '../src/actions-identity.mjs';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const issuer = 'https://token.actions.githubusercontent.com',
  now = Date.parse('2026-11-03T12:00:00Z');
function fixture() {
  const expected = {
    repository: 'example/core',
    repositoryId: 10,
    ownerId: 20,
    runId: 30,
    attempt: 1,
    actorId: 40,
    checkRunId: 50,
    sourceCommit: 'a'.repeat(40),
    audience: 'nibfin:execution:fixture-uuid',
    subject: 'repo:example@20/core@10:ref:refs/heads/main',
    workflowRef: 'example/core/.github/workflows/nibfin.yml@refs/heads/main',
    ref: 'refs/heads/main',
  };
  const header = { typ: 'JWT', alg: 'RS256', kid: 'fixture-key' };
  const payload = {
    iss: issuer,
    aud: expected.audience,
    sub: expected.subject,
    iat: now / 1000 - 10,
    nbf: now / 1000 - 10,
    exp: now / 1000 + 290,
    jti: 'synthetic-token-id',
    repository: expected.repository,
    repository_id: '10',
    repository_owner_id: '20',
    repository_visibility: 'public',
    run_id: '30',
    run_attempt: '1',
    actor_id: '40',
    check_run_id: '50',
    runner_environment: 'self-hosted',
    event_name: 'workflow_dispatch',
    workflow_ref: expected.workflowRef,
    workflow_sha: expected.sourceCommit,
    sha: expected.sourceCommit,
    ref: expected.ref,
    ref_type: 'branch',
    head_ref: '',
    base_ref: '',
  };
  const keys = {
    keys: [
      {
        ...publicKey.export({ format: 'jwk' }),
        kid: 'fixture-key',
        use: 'sig',
        alg: 'RS256',
      },
    ],
  };
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push(url);
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers, undefined);
    assert.ok(
      [
        `${issuer}/.well-known/openid-configuration`,
        `${issuer}/.well-known/jwks`,
      ].includes(url),
    );
    return {
      ok: true,
      text: async () =>
        JSON.stringify(
          url.endsWith('/jwks')
            ? keys
            : { issuer, jwks_uri: `${issuer}/.well-known/jwks` },
        ),
    };
  };
  const token = () => {
    const body = [header, payload]
      .map((value) => Buffer.from(JSON.stringify(value)).toString('base64url'))
      .join('.');
    const signature = sign('RSA-SHA256', Buffer.from(body), privateKey);
    return `${body}.${signature.toString('base64url')}`;
  };
  return { expected, header, payload, keys, fetcher, calls, token };
}

test(
  'GitHub-native signature and current exact job check ' +
    'identity establish caller provenance',
  async () => {
    const f = fixture(),
      proof = await verifyActionsIdentity(f.token(), f.expected, {
        fetcher: f.fetcher,
        now,
      });
    assert.equal(proof.checkRunId, 50);
    assert.equal(proof.runId, 30);
    assert.match(proof.identityHash, /^[a-f0-9]{64}$/);
    assert.equal(Object.hasOwn(proof, 'token'), false);
    assert.equal(f.calls.length, 2);
  },
);

test('direct callers accept only absent or exact signed self-source pairs', async () => {
  const f = fixture();
  f.payload.job_workflow_ref = f.expected.workflowRef;
  f.payload.job_workflow_sha = f.expected.sourceCommit;
  const proof = await verifyActionsIdentity(f.token(), f.expected, {
    fetcher: f.fetcher,
    now,
  });
  assert.equal(proof.sourceCommit, f.expected.sourceCommit);
  for (const pair of [
    { job_workflow_ref: f.expected.workflowRef },
    { job_workflow_sha: f.expected.sourceCommit },
    { job_workflow_ref: null, job_workflow_sha: null },
    { job_workflow_ref: '', job_workflow_sha: '' },
    { job_workflow_ref: null },
    { job_workflow_sha: '' },
    {
      job_workflow_ref: 'foreign/workflow@refs/heads/main',
      job_workflow_sha: f.expected.sourceCommit,
    },
    { job_workflow_ref: f.expected.workflowRef, job_workflow_sha: 'b'.repeat(40) },
  ]) {
    const rejected = fixture();
    Object.assign(rejected.payload, pair);
    await assert.rejects(
      verifyActionsIdentity(rejected.token(), rejected.expected, {
        fetcher: rejected.fetcher,
        now,
      }),
      /UNEXPECTED_REUSABLE_WORKFLOW/,
    );
  }
});

test('reusable callers require their separately adopted exact source', async () => {
  const f = fixture();
  f.expected.reusable = {
    ref: `example/reusable/.github/workflows/stage.yml@${'b'.repeat(40)}`,
    commit: 'b'.repeat(40),
  };
  f.payload.job_workflow_ref = f.expected.workflowRef;
  f.payload.job_workflow_sha = f.expected.sourceCommit;
  const options = { fetcher: f.fetcher, now };
  await assert.rejects(
    verifyActionsIdentity(f.token(), f.expected, options),
    /OIDC_REUSABLE_SOURCE_MISMATCH/,
  );
  f.payload.job_workflow_ref = f.expected.reusable.ref;
  f.payload.job_workflow_sha = f.expected.reusable.commit;
  assert.equal((await verifyActionsIdentity(f.token(), f.expected, options)).runId, 30);
});

test(
  'signed foreign jobs, forks, stale tokens, wrong ' +
    'audience/source and unexpected reusable workflows ' +
    'reject',
  async () => {
    for (const mutate of [
      (f) => {
        f.payload.check_run_id = '51';
      },
      (f) => {
        f.payload.run_attempt = '2';
      },
      (f) => {
        f.payload.event_name = 'pull_request';
      },
      (f) => {
        f.payload.repository_id = '99';
      },
      (f) => {
        f.payload.aud = 'nibfin:other';
      },
      (f) => {
        f.payload.workflow_sha = 'b'.repeat(40);
      },
      (f) => {
        f.payload.runner_environment = 'github-hosted';
      },
      (f) => {
        f.payload.exp = now / 1000;
      },
      (f) => {
        f.payload.iat = now / 1000 + 20;
      },
      (f) => {
        f.payload.job_workflow_sha = 'b'.repeat(40);
      },
      (f) => {
        f.payload.sub = 'repo:foreign/core:ref:refs/heads/main';
      },
    ]) {
      const f = fixture();
      mutate(f);
      await assert.rejects(
        verifyActionsIdentity(f.token(), f.expected, { fetcher: f.fetcher, now }),
      );
    }
  },
);

test(
  'unsigned or attacker-selected signing keys and ' +
    'duplicate key identities cannot verify',
  async () => {
    const f = fixture(),
      parts = f.token().split('.');
    parts[2] = Buffer.alloc(256).toString('base64url');
    await assert.rejects(
      verifyActionsIdentity(parts.join('.'), f.expected, { fetcher: f.fetcher, now }),
      /OIDC_SIGNATURE_INVALID/,
    );
    f.header.jku = 'https://attacker.invalid/keys';
    await assert.rejects(
      verifyActionsIdentity(f.token(), f.expected, { fetcher: f.fetcher, now }),
      /UNTRUSTED_OIDC_HEADER/,
    );
    delete f.header.jku;
    f.keys.keys.push(f.keys.keys[0]);
    await assert.rejects(
      verifyActionsIdentity(f.token(), f.expected, { fetcher: f.fetcher, now }),
      /OIDC_KEY_NOT_UNIQUE/,
    );
  },
);

test(
  'request credential goes only to the fixed GitHub ' +
    'token-service origin and redirects are forbidden',
  async () => {
    let requests = 0;
    const fetcher = async (url, options) => {
      requests++;
      assert.equal(new URL(url).searchParams.get('audience'), 'nibfin:fixture');
      assert.equal(options.headers.Authorization, 'Bearer fixture-request-token');
      assert.equal(options.redirect, 'error');
      return { ok: true, text: async () => '{"value":"synthetic-token"}' };
    };
    const options = {
      requestUrl: 'https://vstoken.actions.githubusercontent.com/token?api-version=2.0',
      requestToken: 'fixture-request-token',
      audience: 'nibfin:fixture',
    };
    assert.equal(await requestActionsIdentity(options, fetcher), 'synthetic-token');
    for (const requestUrl of [
      'https://actions.githubusercontent.com.attacker.invalid/token',
      'http://vstoken.actions.githubusercontent.com/token',
      'https://credential@vstoken.actions.githubusercontent.com/token',
    ])
      await assert.rejects(requestActionsIdentity({ ...options, requestUrl }, fetcher));
    assert.equal(requests, 1);
  },
);

test('issues OIDC requires an explicit adopted event entry', async () => {
  const f = fixture();
  f.payload.event_name = 'issues';
  const options = { fetcher: f.fetcher, now };
  await assert.rejects(verifyActionsIdentity(f.token(), f.expected, options));
  f.expected.eventName = 'issues';
  assert.equal((await verifyActionsIdentity(f.token(), f.expected, options)).runId, 30);
  f.expected.eventName = 'pull_request';
  f.payload.event_name = 'pull_request';
  await assert.rejects(verifyActionsIdentity(f.token(), f.expected, options));
});

function delayedCaller(configure) {
  const f = fixture();
  const executionId = '00000000-0000-4000-8000-000000000001';
  f.payload.aud = `nibfin:10:${executionId}`;
  configure(f.payload);
  let current = now;
  const caller = actionsCaller({
    pin: f.expected, executionId, clock: () => current,
    requestUrl: 'https://vstoken.actions.githubusercontent.com/token',
    requestToken: 'synthetic-request-credential',
    fetcher: async (url, options) => {
      if (url.startsWith('https://vstoken.'))
        return { ok: true, text: async () => JSON.stringify({ value: f.token() }) };
      const response = await f.fetcher(url, options);
      if (url.endsWith('/jwks')) current = now + 2000;
      return response;
    },
  });
  return () => caller(f.expected);
}

test('expiry during signing-key retrieval cannot authorize a caller', async () => {
  const call = delayedCaller(payload => { payload.exp = now / 1000 + 1; });
  await assert.rejects(call(), { code: 'OIDC_EXPIRED' });
});

test('activation uses verification time without permitting future claims', async () => {
  const active = delayedCaller(payload => {
    payload.iat = now / 1000 + 1;
    payload.nbf = now / 1000 + 1;
  });
  assert.equal((await active()).runId, 30);
  const future = delayedCaller(payload => {
    payload.iat = now / 1000 + 3;
    payload.nbf = now / 1000 + 3;
  });
  await assert.rejects(future(), { code: 'OIDC_ISSUED_IN_FUTURE' });
});
