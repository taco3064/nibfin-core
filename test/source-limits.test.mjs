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
