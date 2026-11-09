import test from 'node:test';
import assert from 'node:assert/strict';
import { rgba, composite, contrast, requireContrast }
  from '../website/scripts/contrast.mjs';

test('contrast uses linear light and composites translucent foregrounds', () => {
  assert.equal(contrast(rgba('#000000'), rgba('#ffffff')), 21);
  assert.deepEqual(composite([1, 2, 3, 0], [4, 5, 6, 0]), [0, 0, 0, 0]);
  assert.deepEqual(composite([0, 0, 0, 0.5], rgba('#ffffff')),
    [127.5, 127.5, 127.5, 1]);
  assert.throws(() => requireContrast('rgba(0, 0, 0, 0.1)', '#ffffff',
    4.5, 'Faded text'), /Faded text/);
  assert.throws(() => requireContrast('#eeeeee', '#ffffff', 4.5,
    'Low contrast'), /Low contrast/);
  assert(requireContrast('#000000', '#ffffff', 4.5, 'Text') >= 4.5);
});
