import test from 'node:test';
import assert from 'node:assert/strict';
import observation from './native-protection-observation.json' with { type: 'json' };
import { readProtection } from '../src/github-protection.mjs';
import { verifyMergeEnforcement } from '../src/merge-enforcement.mjs';
import { digest } from '../src/identity.mjs';

function fixture() {
  const data = structuredClone(observation);
  const repository = data.origin.repository;
  const root = `/repos/${repository}`;
  const reader = {
    get: async (path) => {
      if (path === `${root}/branches/main/protection`)
        return structuredClone(data.policy);
      if (path === `${root}/rulesets/${data.ruleset.id}`)
        return structuredClone(data.ruleset);
      assert.fail(`Unexpected request: ${path}`);
    },
    list: async (path) => {
      assert.equal(path, `${root}/rules/branches/main`);
      return structuredClone(data.rules);
    },
  };
  const pin = { id: data.ruleset.id, hash: digest(data.ruleset) };
  const read = () => readProtection(reader, repository, 'main', pin);
  const mergePin = {
    ruleSuiteId: data.suite.id,
    repositoryId: data.suite.repository_id,
    base: data.suite.before_sha,
    merge: data.suite.after_sha,
  };
  const verify = async () =>
    verifyMergeEnforcement(
      data.suite,
      mergePin,
      data.suite.actor_id,
      'main',
      await read(),
    );
  return { data, pin, read, reader, repository, verify, mergePin };
}

test('mixed native suites accept absent evaluation_result', async () => {
  const f = fixture();
  assert.equal(Object.hasOwn(f.data.suite, 'evaluation_result'), false);
  await f.verify();
  assert.notEqual((await f.read()).hash, digest(f.data.policy));
  await assert.rejects(
    readProtection(f.reader, f.repository, 'main'),
    /UNSUPPORTED_EFFECTIVE_RULES/,
  );
});

test('adopting a hash cannot permit weaker or unknown ruleset policies', async () => {
  const edits = [
    (d) => {
      d.ruleset.enforcement = 'evaluate';
    },
    (d) => {
      delete d.ruleset.bypass_actors;
    },
    (d) => {
      d.ruleset.bypass_actors.push({ actor_type: 'RepositoryRole', actor_id: 5 });
    },
    (d) => {
      d.ruleset.conditions.ref_name.include.push('refs/heads/other');
    },
    (d) => {
      d.ruleset.source_type = 'Organization';
    },
    (d) => {
      d.ruleset.rules.push({ type: 'creation' });
    },
    (d) => {
      d.ruleset.rules[0].parameters.required_approving_review_count = 1;
    },
    (d) => {
      d.ruleset.rules[0].parameters.required_reviewers = [{ id: 1 }];
    },
    (d) => {
      d.ruleset.rules[0].parameters.require_code_owner_review = true;
    },
    (d) => {
      d.ruleset.rules[0].parameters.unknown_policy = false;
    },
    (d) => {
      d.ruleset.rules[1].parameters.do_not_enforce_on_create = true;
    },
    (d) => {
      d.ruleset.rules[1].parameters.strict_required_status_checks_policy = false;
    },
    (d) => {
      d.ruleset.rules[1].parameters.required_status_checks[0].integration_id = -1;
    },
    (d) => {
      d.ruleset.rules[1].parameters.required_status_checks[0].app_id = 15368;
    },
  ];
  for (const edit of edits) {
    const f = fixture();
    edit(f.data);
    f.pin.hash = digest(f.data.ruleset);
    await assert.rejects(f.read());
  }
});

test('current ruleset and effective-rule revocation cannot reuse adoption', async () => {
  for (const edit of [
    (d) => {
      d.ruleset.name += ' changed';
    },
    (d) => {
      d.rules.push({ ...d.rules[0], ruleset_id: 999 });
    },
    (d) => {
      d.rules[0].ruleset_id = 999;
    },
    (d) => {
      d.rules[0].ruleset_source = 'foreign/repo';
    },
    (d) => {
      d.rules[0].parameters = {};
    },
  ]) {
    const f = fixture();
    await f.read();
    edit(f.data);
    await assert.rejects(f.read());
  }
});

test('missing or foreign merge enforcement refuses authority', async () => {
  for (const edit of [
    (s) => {
      s.result = 'bypass';
    },
    (s) => {
      s.evaluation_result = 'fail';
    },
    (s) => {
      s.evaluation_result = null;
    },
    (s) => {
      s.actor_id++;
    },
    (s) => {
      s.before_sha = 'a'.repeat(40);
    },
    (s) => {
      s.after_sha = 'a'.repeat(40);
    },
    (s) => {
      s.ref = 'refs/heads/other';
    },
    (s) => {
      s.rule_evaluations[0].enforcement = 'evaluate';
    },
    (s) => {
      s.rule_evaluations[0].result = 'fail';
    },
    (s) => {
      s.rule_evaluations.pop();
    },
    (s) => {
      s.rule_evaluations.at(-1).rule_source.id++;
    },
    (s) => {
      s.rule_evaluations.at(-1).rule_source.type = 'unknown';
    },
    (s) => {
      s.rule_evaluations.push(s.rule_evaluations.at(-1));
    },
  ]) {
    const f = fixture();
    // Bind the expected actor before tampering, as the real reader does from PR.
    const actor = f.data.suite.actor_id;
    const protection = await f.read();
    edit(f.data.suite);
    assert.throws(
      () => verifyMergeEnforcement(f.data.suite, f.mergePin, actor, 'main', protection),
      /MISSING_OR_BYPASSED_MERGE_ENFORCEMENT/,
    );
  }
});
