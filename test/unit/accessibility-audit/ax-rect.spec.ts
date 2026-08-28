import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {toAxRect} from '../../../src/services/ios/accessibility-audit/ax-values.js';

/**
 * The daemon sends a `CGRect` as an `NSValue` whose struct is Foundation's
 * string form, discriminated by `NS.special: 3`.
 */
describe('toAxRect', function () {
  const rect = (rectval: unknown, special: unknown = 3) => ({'NS.rectval': rectval, 'NS.special': special});

  it('parses the Foundation rect string', function () {
    assert.deepStrictEqual(toAxRect(rect('{{16, 186}, {18, 18}}')), {x: 16, y: 186, width: 18, height: 18});
  });

  it('keeps fractional coordinates', function () {
    assert.deepStrictEqual(toAxRect(rect('{{16, 186.33333333333334}, {291.66666666666669, 20.5}}')), {
      x: 16,
      y: 186.33333333333334,
      width: 291.66666666666669,
      height: 20.5,
    });
  });

  it('accepts negative origins', function () {
    assert.deepStrictEqual(toAxRect(rect('{{-8, -2.5}, {10, 4}}')), {x: -8, y: -2.5, width: 10, height: 4});
  });

  it('returns undefined for an unresolved archiver reference', function () {
    // A bare index means the decoder did not dereference the NSValue.
    assert.strictEqual(toAxRect(rect(42)), undefined);
  });

  it('returns undefined when NS.special is not a rect', function () {
    // 1 is a point, 2 a size — neither carries rect coordinates. Note the key is
    // omitted rather than passed as undefined, which would take the default.
    assert.strictEqual(toAxRect(rect('{{0, 0}, {1, 1}}', 1)), undefined);
    assert.strictEqual(toAxRect(rect('{{0, 0}, {1, 1}}', 2)), undefined);
    assert.strictEqual(toAxRect({'NS.rectval': '{{0, 0}, {1, 1}}'}), undefined);
  });

  it('returns undefined for malformed or non-object input', function () {
    assert.strictEqual(toAxRect(rect('{{0, 0}}')), undefined);
    assert.strictEqual(toAxRect(rect('not a rect')), undefined);
    assert.strictEqual(toAxRect(null), undefined);
    assert.strictEqual(toAxRect('{{0, 0}, {1, 1}}'), undefined);
    assert.strictEqual(toAxRect([1, 2, 3]), undefined);
  });
});
