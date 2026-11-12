import { digest } from '../src/identity.mjs';
import { evidenceBinding, stages } from '../src/stages.mjs';
import { approvalRecord } from './approval-fixture.mjs';
export function stageFixture(stage = 'shape') {
  const record = approvalRecord();
  record.roles = { author: 1, validator: 1, publisher: 1, writer: 1, acceptor: 1 };
  record.operations = [
    'shape',
    'validate-shape',
    'publish-shape',
    'deliver',
    'hooks',
    'accept',
    'commit-pr',
    'review-pr',
    'merge',
    'close',
  ];
  const shapeBody =
    'Approved Shape\n```kairo-candidate\n{"artifacts":[],"hooks":[]}\n```\n';
  const context = {
    main: { repositoryId: 10, head: '1'.repeat(40), observationHash: '9'.repeat(64) },
    approval: { record, approvalHash: 'd'.repeat(64) },
    source: record.source,
    issue: {
      node_id: record.issue.id,
      number: record.issue.number,
      state: 'open',
      url: 'https://api.github.com/repos/example/core/issues/2',
      body: record.scope.body,
      labels: [{ name: 'scope' }],
    },
    dependencies: { identities: [], ready: true },
    route: { userId: 1, label: 'nibfin-user-1' },
    runner: {
      os: 'linux',
      runId: 1,
      attempt: 1,
      jobId: 2,
      runnerId: 3,
      memberId: 1,
      repositoryId: 10,
      observationHash: 'e'.repeat(64),
    },
    isolation: {
      profile: 'linux-rootless-docker-v1',
      observationHash: 'f'.repeat(64),
      writerStatus: 'exclusive',
    },
    shape: { body: shapeBody, hash: digest(shapeBody) },
    receipts: {},
    candidate: {
      repositoryId: 10,
      repository: 'example/core',
      issueId: 'I_target',
      base: '1'.repeat(40),
      tree: '2'.repeat(40),
      diffHash: '3'.repeat(64),
      paths: ['src/example.mjs'],
      obligations: { artifacts: [], hooks: [] },
      artifacts: [],
      hookSources: [],
    },
    pr: {
      id: 'PR_1',
      number: 1,
      repositoryId: 10,
      base: '1'.repeat(40),
      head: '4'.repeat(40),
      tree: '2'.repeat(40),
      state: 'open',
      mergePreview: '5'.repeat(40),
    },
  };
  context.ci = {
    prId: 'PR_1',
    head: context.pr.head,
    base: context.pr.base,
    testedSha: context.pr.head,
    provenanceHash: '6'.repeat(64),
    protectionHash: '7'.repeat(64),
    checks: [
      {
        id: 10,
        appId: 15368,
        status: 'completed',
        conclusion: 'success',
        testedSha: context.pr.head,
      },
    ],
  };
  const shapeArtifacts = { shapeHash: context.shape.hash };
  const candidateArtifacts = {
    ...shapeArtifacts,
    candidateHash: digest(context.candidate),
  };
  const prArtifacts = {
    ...candidateArtifacts,
    prId: context.pr.id,
    prNumber: context.pr.number,
    head: context.pr.head,
    base: context.pr.base,
  };
  const reviewArtifacts = { ...prArtifacts, ciHash: digest(context.ci) };
  let index = 1;
  const identities = {};
  for (const key of Object.keys(stages)) {
    const role = stages[key].role;
    const id = String(index++).padStart(12, '0');
    identities[key] = {
      id: `00000000-0000-4000-8000-${id}`,
      sessionId: `11111111-0000-4000-8000-${id}`,
      role,
      actorId: record.roles[role],
      runId: 1,
      attempt: 1,
      jobId: 2,
    };
  }
  for (const [key, outcome, artifacts] of [
    ['shape', 'ready', shapeArtifacts],
    ['validate-shape', 'approved', shapeArtifacts],
    ['publish-shape', 'published', shapeArtifacts],
    ['deliver', 'ready', candidateArtifacts],
    ['pre-accept-hooks', 'passed', candidateArtifacts],
    ['accept', 'accepted', candidateArtifacts],
    ['post-accept-hooks', 'passed', candidateArtifacts],
    ['commit-pr', 'published', prArtifacts],
    ['review-pr', 'approved', reviewArtifacts],
    ['merge', 'merged', { ...reviewArtifacts, mergeCommit: '8'.repeat(40) }],
  ])
    context.receipts[key] = {
      schemaVersion: 1,
      stage: key,
      binding: evidenceBinding(context),
      execution: identities[key],
      artifacts,
      outcome,
      findings: [],
      references: ['https://github.com/example/core/actions/runs/1'],
    };
  context.execution = identities[stage];
  context.isolation.executionId = context.execution.id;
  if (!['shape', 'validate-shape', 'publish-shape'].includes(stage)) {
    context.issue.body = context.shape.body;
    context.issue.labels.push({ name: 'shaped' });
  }
  if (stage === 'close')
    Object.assign(context.pr, {
      state: 'closed',
      merged: true,
      mergeCommit: '8'.repeat(40),
    });
  context.pause = { status: 'clear', issueId: record.issue.id,
    repositoryId: record.issue.repositoryId, observationHash: 'a'.repeat(64),
    current: context.issue };
  return context;
}
