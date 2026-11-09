import { digest, isDigest, isId, isSha, requireThat } from './identity.mjs';
import { validateApprovalRecord } from './approval-record.mjs';
import { issuePath } from './github-read.mjs';
import { canonicalCandidateBlock, candidateContract,
  safeCandidatePath } from './candidate-contract.mjs';
import { requireExecutionIsolation } from './execution-profiles.mjs';

// Adapted from Kairo's pure stage/evidence gates. Only a trusted live observer
// may supply context and receipts. This module authenticates no JSON caller.
export const stages = Object.freeze({
  shape: { operation: 'shape', role: 'author' },
  'validate-shape': { operation: 'validate-shape', role: 'validator' },
  'publish-shape': { operation: 'publish-shape', role: 'publisher' },
  deliver: { operation: 'deliver', role: 'writer' },
  'pre-accept-hooks': { operation: 'hooks', role: 'publisher' },
  accept: { operation: 'accept', role: 'acceptor' },
  'post-accept-hooks': { operation: 'hooks', role: 'publisher' },
  'commit-pr': { operation: 'commit-pr', role: 'publisher' },
  'review-pr': { operation: 'review-pr', role: 'author' },
  merge: { operation: 'merge', role: 'publisher' },
  close: { operation: 'close', role: 'publisher' },
});
const uuid = (value) =>
  typeof value === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
export function evidenceBinding(context) {
  return {
    issueId: context.approval.record.issue.id,
    approvalHash: context.approval.approvalHash,
    scopeHash: context.approval.scopeBinding ?? context.approval.record.scope.hash,
    sourceHash: digest(context.approval.record.source),
  };
}
export function executionIdentity(value, role, actorId) {
  requireThat(
    value?.role === role &&
      value.actorId === actorId &&
      uuid(value.id) &&
      uuid(value.sessionId) &&
      isId(value.runId) &&
      isId(value.attempt) &&
      isId(value.jobId),
    'INVALID_ROLE_EXECUTION',
  );
  return value;
}
function receipt(context, stage, artifacts, outcome) {
  const value = context.receipts?.[stage],
    definition = stages[stage];
  const priorHash = value?.artifacts?.candidateHash;
  const reusable = ['pre-accept-hooks', 'accept', 'post-accept-hooks', 'review-pr'];
  if (reusable.includes(stage) && artifacts.candidateHash &&
    context.equivalentCandidates?.includes(priorHash)) {
    artifacts = { ...artifacts, candidateHash: priorHash };
  }
  requireThat(
    value?.schemaVersion === 1 &&
      value.stage === stage &&
      !Object.hasOwn(value, 'authorized') &&
      digest(value.binding) === digest(evidenceBinding(context)) &&
      digest(value.artifacts) === digest(artifacts),
    'MISSING_OR_STALE_RECEIPT',
  );
  executionIdentity(
    value.execution,
    definition.role,
    context.approval.record.roles[definition.role],
  );
  requireThat(
    value.outcome === outcome &&
      Array.isArray(value.findings) &&
      value.findings.length === 0 &&
      Array.isArray(value.references) &&
      value.references.length > 0 &&
      value.references.every((ref) => typeof ref === 'string' && ref.trim()),
    'UNSUCCESSFUL_RECEIPT',
  );
  return value;
}
function independent(first, second) {
  requireThat(
    first.execution.id !== second.execution.id &&
      first.execution.sessionId !== second.execution.sessionId,
    'SELF_REVIEW_REJECTED',
  );
}
function shapeEvidence(context, requireValidator) {
  const body = context.shape?.body;
  requireThat(
    typeof body === 'string' && body.trim() && context.shape.hash === digest(body),
    'SHAPE_IDENTITY_MISMATCH',
  );
  candidateContract(body);
  const artifacts = { shapeHash: context.shape.hash };
  const prior = context.receipts.shape?.artifacts?.requirementsHash;
  if (prior !== undefined) {
    requireThat(isDigest(prior), 'INVALID_REQUIREMENTS_EVIDENCE');
    artifacts.requirementsHash = prior;
  }
  if (!context.issue.labels.some(label => label.name === 'shaped')) {
    const requirements = requirementsText(context.issue.body);
    requireThat(prior ? prior === digest(requirements) :
      requirements === requirementsText(context.approval.record.scope.body),
    'SHAPE_REQUIREMENTS_CHANGED');
  }
  const author = receipt(context, 'shape', artifacts, 'ready');
  if (requireValidator)
    independent(author, receipt(context, 'validate-shape', artifacts, 'approved'));
  return artifacts;
}
// Preserve whitespace within requirements and Markdown blocks.
export function requirementsText(body) {
  return typeof body === 'string' ? body.replaceAll('\r\n', '\n').trimEnd() : body;
}
export function stageRequestHash({
  stage, binding, artifacts, execution, runner, isolation, body, shaped,
}) {
  const requirements = requirementsText(body);
  return digest({ stage, binding, artifacts, execution, runner, isolation,
    requirements: digest(shaped ? canonicalCandidateBlock(requirements) : requirements),
  });
}
export function samePublishedRequirements(current, prior) {
  return canonicalCandidateBlock(requirementsText(current)) ===
    canonicalCandidateBlock(requirementsText(prior));
}
function publication(context) {
  const artifacts = { shapeHash: context.shape.hash };
  const reviewed = context.receipts['publish-shape']?.artifacts?.requirementsHash;
  receipt(context, 'publish-shape', {
    ...artifacts, ...(reviewed ? { requirementsHash: reviewed } : {}),
  }, 'published');
  requireThat(samePublishedRequirements(context.issue.body, context.shape.body),
    'PUBLISHED_SHAPE_CHANGED');
  return artifacts;
}
function candidateEvidence(context) {
  const candidate = context.candidate,
    issue = context.approval.record.issue;
  requireThat(
    candidate?.repositoryId === issue.repositoryId &&
      candidate.repository === issue.repository &&
      candidate.issueId === issue.id &&
      isSha(candidate.base) &&
      isSha(candidate.tree) &&
      isDigest(candidate.diffHash) &&
      Array.isArray(candidate.paths) &&
      candidate.paths.length > 0 &&
      candidate.paths.every(safeCandidatePath) &&
      new Set(candidate.paths).size === candidate.paths.length,
    'INVALID_CANDIDATE',
  );
  requireThat(
    candidate.paths.every(
      (path) =>
        !path.startsWith('.nibfin/') &&
        !path.startsWith('.github/workflows/') &&
        !['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'].includes(path),
    ),
    'ENFORCEMENT_CHANGE_REQUIRES_SEPARATE_APPROVAL',
  );
  const obligations = candidateContract(context.shape.body);
  requireThat(
    digest(candidate.obligations) === digest(obligations),
    'CANDIDATE_OBLIGATIONS_CHANGED',
  );
  for (const [field, expected] of [
    ['artifacts', obligations.artifacts],
    ['hookSources', obligations.hooks],
  ]) {
    const actual = candidate[field];
    requireThat(
      Array.isArray(actual) &&
        actual.length === expected.length &&
        expected.every(
          (entry, index) =>
            Object.entries(entry).every(
              ([key, value]) => actual[index]?.[key] === value,
            ) &&
            isDigest(actual[index].sha256) &&
            Number.isSafeInteger(actual[index].size) &&
            actual[index].size >= 0,
        ),
      'MISSING_ARTIFACT_IDENTITY',
    );
  }
  const artifacts = {
    shapeHash: context.shape.hash,
    candidateHash: digest(candidate),
  };
  receipt(context, 'deliver', artifacts, 'ready');
  return artifacts;
}
function acceptance(context, artifacts) {
  const accept = receipt(context, 'accept', artifacts, 'accepted');
  independent(context.receipts.deliver, accept);
  return accept;
}
function pullRequest(context, artifacts) {
  const pr = context.pr;
  requireThat(
    pr &&
      typeof pr.id === 'string' &&
      pr.id &&
      isId(pr.number) &&
      isSha(pr.head) &&
      isSha(pr.base) &&
      pr.repositoryId === context.approval.record.issue.repositoryId &&
      pr.tree === context.candidate.tree &&
      pr.state === 'open',
    'PR_CANDIDATE_MISMATCH',
  );
  receipt(
    context,
    'commit-pr',
    { ...artifacts, prId: pr.id, prNumber: pr.number,
      head: pr.publishedHead ?? pr.head, base: context.candidate.base },
    'published',
  );
  return {
    ...artifacts,
    prId: pr.id,
    prNumber: pr.number,
    head: pr.publishedHead ?? pr.head,
  };
}
function verifyContentReview(context, artifacts) {
  const prior = context.receipts['review-pr']?.artifacts;
  const legacy = isSha(prior?.base) && isDigest(prior?.ciHash)
    ? { base: prior.base, ciHash: prior.ciHash } : {};
  const sameContent = context.equivalentCandidates?.includes(prior?.candidateHash);
  const identity = sameContent && prior.prId === artifacts.prId && isSha(prior.head)
    ? { ...artifacts, head: prior.head } : artifacts;
  const review = receipt(context, 'review-pr', { ...identity, ...legacy }, 'approved');
  independent(context.receipts.deliver, review);
}
function ci(context) {
  const evidence = context.ci;
  requireThat(
    evidence &&
      evidence.prId === context.pr.id &&
      evidence.head === context.pr.head &&
      evidence.base === context.pr.base &&
      isSha(evidence.testedSha) &&
      isDigest(evidence.provenanceHash) &&
      isDigest(evidence.protectionHash) &&
      Array.isArray(evidence.checks) &&
      evidence.checks.length > 0 &&
      evidence.checks.every(
        (check) =>
          isId(check.id) &&
          isId(check.appId) &&
          check.status === 'completed' &&
          check.conclusion === 'success' &&
          check.testedSha === evidence.testedSha,
      ),
    'CI_PROVENANCE_REQUIRED',
  );
  if (evidence.testedSha !== context.pr.head) {
    requireThat(
      evidence.testedSha === context.pr.mergePreview &&
        Array.isArray(evidence.parents) &&
        digest(evidence.parents) === digest([context.pr.base, context.pr.head]),
      'FOREIGN_TEST_MERGE',
    );
  }
  return { ciHash: digest(evidence) };
}

export function decideStage(stage, context, now = Date.now()) {
  try {
    const definition = Object.hasOwn(stages, stage) ? stages[stage] : null;
    requireThat(definition, 'UNKNOWN_STAGE');
    const record = validateApprovalRecord(context.approval?.record, now, {
      repositoryAdmission: context.approval?.scopeBinding !== undefined,
    });
    requireThat(
      isDigest(context.approval.approvalHash) &&
        record.operations.includes(definition.operation),
      'OPERATION_NOT_APPROVED',
    );
    const issue = context.issue;
    requireThat(
      issue?.node_id === record.issue.id &&
        issue.number === record.issue.number &&
        !issue.pull_request &&
        issue.url === `https://api.github.com${issuePath(record.issue)}` &&
        issue.state === 'open',
      'ISSUE_CHANGED',
    );
    requireThat(
      digest(context.source) === digest(record.source),
      'INSTALLED_SOURCE_CHANGED',
    );
    requireThat(
      context.dependencies?.ready === true &&
        digest(context.dependencies.identities) === digest(record.prerequisites),
      'PREREQUISITES_NOT_READY',
    );
    requireThat(
      context.main?.repositoryId === record.issue.repositoryId &&
        isSha(context.main.head) &&
        isDigest(context.main.observationHash),
      'CURRENT_MAIN_REQUIRED',
    );
    const role = definition.role,
      execution = executionIdentity(context.execution, role, record.roles[role]);
    requireThat(
      context.runner?.runId === execution.runId &&
        context.runner.attempt === execution.attempt &&
        context.runner.jobId === execution.jobId &&
        context.runner.repositoryId === record.issue.repositoryId &&
        context.runner.memberId === context.route?.userId &&
        execution.actorId === context.runner.memberId &&
        isId(context.runner.runnerId) &&
        isDigest(context.runner.observationHash),
      'RUNNER_BINDING_REQUIRED',
    );
    requireExecutionIsolation(context.isolation, context.runner, execution);
    requireThat(
      Array.isArray(issue.labels) &&
        issue.labels.every((label) => typeof label?.name === 'string'),
      'INVALID_LABELS',
    );
    const labels = new Set(issue.labels.map((label) => label.name));
    requireThat(labels.has('scope') && !labels.has('delivered'), 'INACTIVE_SCOPE');
    let artifacts = {};
    if (['shape', 'validate-shape', 'publish-shape'].includes(stage)) {
      if (labels.has('shaped')) {
        candidateContract(issue.body);
        if (stage !== 'shape')
          requireThat(
            context.shape?.body === issue.body,
            'CURRENT_SHAPE_REVALIDATION_CHANGED',
          );
      } else requireThat(typeof issue.body === 'string' && issue.body.trim(),
        'EMPTY_ISSUE_BODY');
      if (stage !== 'shape')
        artifacts = shapeEvidence(context, stage === 'publish-shape');
    } else {
      requireThat(labels.has('shaped'), 'SHAPE_NOT_PUBLISHED');
      artifacts = publication(context);
      if (stage !== 'deliver') artifacts = candidateEvidence(context);
      if (
        [
          'accept',
          'post-accept-hooks',
          'commit-pr',
          'review-pr',
          'merge',
          'close',
        ].includes(stage)
      ) {
        receipt(context, 'pre-accept-hooks', artifacts, 'passed');
      }
      if (
        ['post-accept-hooks', 'commit-pr', 'review-pr', 'merge', 'close'].includes(
          stage,
        )
      )
        acceptance(context, artifacts);
      if (['commit-pr', 'review-pr', 'merge', 'close'].includes(stage))
        receipt(context, 'post-accept-hooks', artifacts, 'passed');
      if (['review-pr', 'merge'].includes(stage)) {
        artifacts = pullRequest(context, artifacts);
      }
      if (stage === 'merge') {
        verifyContentReview(context, artifacts);
        const { head, base } = context.pr;
        Object.assign(artifacts, { head, base }, ci(context));
      }
      if (stage === 'close') {
        requireThat(
          context.pr?.state === 'closed' &&
            context.pr.merged === true &&
            isSha(context.pr.mergeCommit) &&
            context.pr.repositoryId === record.issue.repositoryId &&
            context.pr.tree === context.candidate.tree &&
            isSha(context.pr.head),
          'MERGE_READBACK_REQUIRED',
        );
        artifacts = {
          ...artifacts,
          prId: context.pr.id,
          prNumber: context.pr.number,
          head: context.pr.head,
          base: context.pr.base,
          ...ci(context),
        };
        const { base, ciHash, ...content } = artifacts;
        verifyContentReview(context, { ...content,
          head: context.pr.publishedHead ?? context.pr.head });
        artifacts.mergeCommit = context.pr.mergeCommit;
        receipt(context, 'merge', artifacts, 'merged');
      }
    }
    const binding = evidenceBinding(context);
    const requestHash = stageRequestHash({
      stage,
      binding,
      artifacts,
      execution,
      runner: context.runner.runnerId,
      isolation: context.isolation.profile,
      body: issue.body,
      shaped: labels.has('shaped'),
    });
    return {
      schemaVersion: 1,
      status: 'allowed',
      stage,
      operation: definition.operation,
      role,
      binding,
      artifacts,
      requestHash,
    };
  } catch (error) {
    return {
      schemaVersion: 1,
      status: 'denied',
      stage,
      code: error.code ?? 'INVALID_STAGE_CONTEXT',
    };
  }
}
