import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {decodeMessage, encodeMessage} from '../../../src/lib/remote-xpc/xpc-protocol.js';
import type {XPCDictionary} from '../../../src/lib/types.js';

function roundTrip(body: XPCDictionary): XPCDictionary {
  const decoded = decodeMessage(encodeMessage({flags: 1, id: 1n, body}));
  assert.ok(decoded.message.body, 'expected a decoded body');
  return decoded.message.body;
}

describe('xpc-protocol dictionary key padding', function () {
  it('round-trips an ASCII key (control)', function () {
    assert.deepStrictEqual(roundTrip({abc: 'x', next: 'y'}), {abc: 'x', next: 'y'});
  });

  it('round-trips a key whose UTF-8 byte length differs from its JS string length', function () {
    const body = {clé: 'x', next: 'y'};
    assert.deepStrictEqual(roundTrip(body), body);
  });

  it('round-trips a key with a 3-byte UTF-8 character', function () {
    const body = {'€': 'x', next: 'y'};
    assert.deepStrictEqual(roundTrip(body), body);
  });

  it('round-trips a key with a 4-byte UTF-8 character (surrogate pair)', function () {
    const body = {'🙂': 'x', next: 'y'};
    assert.deepStrictEqual(roundTrip(body), body);
  });
});
