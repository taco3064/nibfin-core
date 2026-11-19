import assert from 'node:assert/strict';
import test from 'node:test';
import { parse } from 'yaml';
import { runInNewContext } from 'node:vm';
import { callerRecipe, callerRecipeVariants } from '../src/caller-recipes.mjs';
import { stages } from '../src/stages.mjs';

const commit = 'a'.repeat(40);
const action = { actionCommit: 'b'.repeat(40), memberId: 2 };
const kinds = ['wake', 'action-wake', 'action-dispatch', 'issue', 'issue-managed'];

// Controlled evaluation of maintained display expressions, not GitHub execution.
function title(kind, inputs = {}, event = {}) {
  const workflow = parse(callerRecipe(kind, commit, action));
  return workflow['run-name'].replace(/\$\{\{([\s\S]*?)\}\}/g, (_, expression) =>
    runInNewContext(expression, {
      inputs,
      github: { repository: 'owner/repo', repository_id: '123', event },
      format: (pattern, ...values) => pattern.replace(/\{(\d+)\}/g,
        (_, index) => String(values[Number(index)])),
    }));
}

test('title blocks preserve YAML content and every other recipe field', () => {
  for (const kind of kinds) {
    const [titled, historical] = callerRecipeVariants(kind, commit, action);
    const workflow = parse(titled);
    assert.equal(typeof workflow['run-name'], 'string');
    assert.ok(workflow['run-name'].includes('#'));
    delete workflow['run-name'];
    assert.deepEqual(workflow, parse(historical));
    assert.equal(historical.includes('run-name:'), false);
    for (const line of titled.split('\n')) assert.ok(line.length <= 90, line);
  }
});

test('dispatch titles identify the target and never infer a live Auto phase', () => {
  const inputs = { issue_number: '42', repository_id: '123' };
  assert.equal(title('wake', inputs), 'Wake · owner/repo#42');
  assert.equal(title('wake', { ...inputs, repository_id: '456' }),
    'Wake · repository ID 456#42');
  assert.equal(title('action-wake', inputs), 'Auto · owner/repo#42');
  for (const stage of [undefined, '', 'continue']) {
    assert.equal(title('action-dispatch', { ...inputs, stage }),
      'Auto · owner/repo#42');
  }
  const names = ['Shape', 'Validate Shape', 'Publish Shape', 'Deliver',
    'Pre-Accept Hooks', 'Accept', 'Post-Accept Hooks', 'Create PR', 'Review PR',
    'Merge', 'Close'];
  assert.equal(Object.keys(stages).length, names.length);
  Object.keys(stages).forEach((stage, index) => {
    assert.equal(title('action-dispatch', { ...inputs, stage }),
      `${names[index]} · owner/repo#42`);
  });
});

test('both native Issue modes retain event and label after identification', () => {
  for (const kind of ['issue', 'issue-managed']) {
    for (const action of ['opened', 'edited', 'assigned', 'unassigned',
      'reopened', 'closed', 'labeled', 'unlabeled']) {
      const event = { issue: { number: 42 }, action, label: {} };
      assert.equal(title(kind, {}, event), `Wake · owner/repo#42 · ${action}`);
      if (['labeled', 'unlabeled'].includes(action)) {
        event.label.name = 'scope #review: "ready"';
        assert.equal(title(kind, {}, event),
          `Wake · owner/repo#42 · ${action} ${event.label.name}`);
      }
    }
  }
});
