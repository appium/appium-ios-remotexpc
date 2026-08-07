import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {XPC_TYPES, decodeMessage, encodeMessage} from '../../../src/lib/remote-xpc/xpc-protocol.js';
import {XPCUUID} from '../../../src/lib/remote-xpc/xpc-uuid.js';
import type {XPCDictionary} from '../../../src/lib/types.js';

const SAMPLE_UUID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const SAMPLE_HEX = '3f2504e04f8911d39a0c0305e82c3301';

describe('XPCUUID', function () {
  describe('construction', function () {
    it('parses a dashed UUID string', function () {
      assert.strictEqual(new XPCUUID(SAMPLE_UUID).uuidBytes.toString('hex'), SAMPLE_HEX);
    });

    it('parses a bare hex string', function () {
      assert.strictEqual(new XPCUUID(SAMPLE_HEX).uuidBytes.toString('hex'), SAMPLE_HEX);
    });

    it('is case-insensitive', function () {
      assert.strictEqual(new XPCUUID(SAMPLE_UUID.toUpperCase()).uuidBytes.toString('hex'), SAMPLE_HEX);
    });

    it('accepts 16 raw bytes', function () {
      const bytes = Buffer.from(SAMPLE_HEX, 'hex');

      assert.strictEqual(new XPCUUID(bytes).uuidBytes.toString('hex'), SAMPLE_HEX);
    });

    it('copies the incoming bytes rather than aliasing them', function () {
      const bytes = Buffer.from(SAMPLE_HEX, 'hex');
      const uuid = new XPCUUID(bytes);

      bytes.fill(0);

      assert.strictEqual(uuid.uuidBytes.toString('hex'), SAMPLE_HEX);
    });

    it('rejects a malformed string', function () {
      assert.throws(() => new XPCUUID('not-a-uuid'), TypeError);
      assert.throws(() => new XPCUUID('3f2504e04f8911d39a0c0305e82c33'), TypeError);
    });

    it('rejects a buffer of the wrong length', function () {
      assert.throws(
        () => new XPCUUID(Buffer.alloc(15)),
        (err: unknown) => err instanceof TypeError && err.message.includes('16 bytes'),
      );
    });

    it('generates distinct random UUIDs', function () {
      assert.notStrictEqual(XPCUUID.random().toString(), XPCUUID.random().toString());
    });
  });

  describe('formatting', function () {
    it('renders the canonical dashed lower-case form', function () {
      assert.strictEqual(new XPCUUID(SAMPLE_HEX).toString(), SAMPLE_UUID);
    });

    it('serializes to the dashed form in JSON', function () {
      assert.strictEqual(JSON.stringify({id: new XPCUUID(SAMPLE_HEX)}), `{"id":"${SAMPLE_UUID}"}`);
    });
  });

  describe('asOptionalUuid', function () {
    it('re-parses the bare hex string the decoder produces', function () {
      // The XPC decoder surfaces UUIDs as 32-char hex, so a device's echoed
      // session id has to survive a round trip back into an XPCUUID.
      assert.strictEqual(XPCUUID.asOptionalUuid(SAMPLE_HEX)?.toString(), SAMPLE_UUID);
    });

    it('passes an existing instance through', function () {
      const uuid = new XPCUUID(SAMPLE_HEX);

      assert.strictEqual(XPCUUID.asOptionalUuid(uuid), uuid);
    });

    it('accepts a 16-byte buffer', function () {
      assert.strictEqual(XPCUUID.asOptionalUuid(Buffer.from(SAMPLE_HEX, 'hex'))?.toString(), SAMPLE_UUID);
    });

    it('returns undefined for values that are not UUIDs', function () {
      assert.strictEqual(XPCUUID.asOptionalUuid(undefined), undefined);
      assert.strictEqual(XPCUUID.asOptionalUuid(42), undefined);
      assert.strictEqual(XPCUUID.asOptionalUuid('nope'), undefined);
      assert.strictEqual(XPCUUID.asOptionalUuid(Buffer.alloc(8)), undefined);
    });
  });

  describe('XPC wire encoding', function () {
    function roundTrip(body: XPCDictionary): XPCDictionary {
      const encoded = encodeMessage({flags: 0, id: 1, body});
      return decodeMessage(encoded).message.body as XPCDictionary;
    }

    it('encodes as XPC_TYPE_UUID rather than data', function () {
      const encoded = encodeMessage({flags: 0, id: 1, body: {id: new XPCUUID(SAMPLE_HEX)}});

      // The 16 raw bytes must appear immediately after the uuid type tag, with
      // no length prefix — that is what distinguishes uuid from data framing.
      const typeTag = Buffer.alloc(4);
      typeTag.writeUInt32LE(XPC_TYPES.uuid, 0);
      const tagIndex = encoded.indexOf(typeTag);
      assert.ok(tagIndex > -1);
      assert.strictEqual(encoded.subarray(tagIndex + 4, tagIndex + 20).toString('hex'), SAMPLE_HEX);
    });

    it('round-trips through encode/decode', function () {
      const decoded = roundTrip({id: new XPCUUID(SAMPLE_HEX)});

      // The decoder returns bare hex; re-parsing must recover the same UUID.
      assert.strictEqual(XPCUUID.asOptionalUuid(decoded.id)?.toString(), SAMPLE_UUID);
    });

    it('encodes a UUID nested in the option-wrapper dictionaries the services use', function () {
      const decoded = roundTrip({
        options: {avcMediaStreamOptionClientSessionID: {uuid: new XPCUUID(SAMPLE_HEX)}},
      });

      const options = decoded.options as XPCDictionary;
      const wrapper = options.avcMediaStreamOptionClientSessionID as XPCDictionary;
      assert.strictEqual(XPCUUID.asOptionalUuid(wrapper.uuid)?.toString(), SAMPLE_UUID);
    });

    it('still encodes a plain Buffer as data', function () {
      const decoded = roundTrip({blob: Buffer.from(SAMPLE_HEX, 'hex')});

      // Data decodes back to a Buffer; a UUID would have decoded to a string.
      assert.strictEqual(Buffer.isBuffer(decoded.blob), true);
    });
  });
});
