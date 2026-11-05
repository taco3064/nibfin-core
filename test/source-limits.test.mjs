import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceLimits } from '../scripts/source-limits.mjs';

test('whole-file limits include existing lines and Unicode characters', () => {
  sourceLimits('valid.mjs', `${'x'.repeat(90)}\r\n`);
  sourceLimits('unicode.mjs', `${'漢'.repeat(90)}\n`);
  sourceLimits('valid.mjs', 'x\n'.repeat(1000));
  assert.throws(
    () => sourceLimits('changed.mjs', `// new\n${'x'.repeat(91)}\n`),
    /SOURCE_LINE_LIMIT: changed.mjs:2/,
  );
  assert.throws(
    () => sourceLimits('changed.mjs', 'x\n'.repeat(1001)),
    /SOURCE_FILE_LIMIT/,
  );
});

test('JSON and YAML data are exempt from both source limits', () => {
  const json = JSON.stringify({ wide: 'x'.repeat(91), many: Array(1001).fill(1) },
    null, 2);
  const yaml = `wide: ${'x'.repeat(91)}\nmany:\n${'  - item\n'.repeat(1001)}`;
  for (const path of ['record.json', 'record.JSON']) {
    assert.doesNotThrow(() => sourceLimits(path, json));
  }
  for (const path of ['workflow.yml', 'workflow.yaml', 'workflow.YAML']) {
    assert.doesNotThrow(() => sourceLimits(path, yaml));
  }
  assert.throws(() => sourceLimits('program.mjs', json), /SOURCE_FILE_LIMIT/);
  assert.throws(() => sourceLimits('program.js', yaml), /SOURCE_FILE_LIMIT/);
});
