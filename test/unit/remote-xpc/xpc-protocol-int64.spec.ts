import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {XPC_TYPES, decodeMessage, encodeMessage} from '../../../src/lib/remote-xpc/xpc-protocol.js';
import type {XPCDictionary} from '../../../src/lib/types.js';

/** RSD `peer_info` → `RemoteXPCVersionFlags` as sent by iOS 17+, above 2^53. */
const REMOTE_XPC_VERSION_FLAGS = 0x0100000000000006n;
const UINT64_MAX = 0xffffffffffffffffn;
const INT64_MAX = 0x7fffffffffffffffn;
const INT64_MIN = -0x8000000000000000n;

function roundTrip(body: XPCDictionary): XPCDictionary {
  const decoded = decodeMessage(encodeMessage({flags: 1, id: 1n, body}));
  assert.ok(decoded.message.body, 'expected a decoded body');
  return decoded.message.body;
}

/** Builds `{v: <int64>}` on the wire; the encoder only emits int64 for safe `number`s, so the 8 bytes are patched. */
function encodeInt64Body(value: bigint): Buffer {
  const payload = encodeMessage({flags: 1, id: 1n, body: {v: 0}});
  const tag = Buffer.alloc(4);
  tag.writeUInt32LE(XPC_TYPES.int64);
  const offset = payload.indexOf(tag);
  assert.ok(offset > 0, 'expected an int64 tag in the payload');
  payload.writeBigInt64LE(value, offset + 4);
  return payload;
}

function decodeInt64(value: bigint): unknown {
  return decodeMessage(encodeInt64Body(value)).message.body?.v;
}

describe('xpc-protocol 64-bit integers', function () {
  describe('uint64 precision', function () {
    it('keeps RemoteXPCVersionFlags exact', function () {
      assert.strictEqual(roundTrip({flags: REMOTE_XPC_VERSION_FLAGS}).flags, REMOTE_XPC_VERSION_FLAGS);
    });

    it('keeps UINT64_MAX exact', function () {
      assert.strictEqual(roundTrip({v: UINT64_MAX}).v, UINT64_MAX);
    });

    it('decodes a safe-range uint64 as a number', function () {
      assert.strictEqual(roundTrip({port: 52280n}).port, 52280);
    });
  });

  describe('int64 precision and sign', function () {
    it('keeps INT64_MAX exact', function () {
      assert.strictEqual(decodeInt64(INT64_MAX), INT64_MAX);
    });

    it('keeps INT64_MIN exact', function () {
      assert.strictEqual(decodeInt64(INT64_MIN), INT64_MIN);
    });

    it('keeps a small negative int64 as a negative number', function () {
      assert.strictEqual(roundTrip({v: -1}).v, -1);
    });

    it('keeps a safe-range int64 as a number', function () {
      assert.strictEqual(roundTrip({v: 52280}).v, 52280);
    });
  });

  describe('wire-type symmetry', function () {
    it('re-encodes a decoded int64 as int64', function () {
      const original = encodeMessage({flags: 1, id: 1n, body: {pid: 4242}});
      const reEncoded = encodeMessage({flags: 1, id: 1n, body: roundTrip({pid: 4242})});

      assert.deepStrictEqual(reEncoded, original);
    });
  });
});
