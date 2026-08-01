import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {TLV8Error} from '../../../../src/lib/apple-tv/errors.js';
import {decodeTLV8, decodeTLV8ToDict} from '../../../../src/lib/apple-tv/tlv/decoder.js';

describe('TLV8 Decoder', function () {
  describe('decodeTLV8', function () {
    it('should decode a single TLV8 item', function () {
      const buffer = Buffer.from([0x01, 0x03, 0x42, 0x43, 0x44]);

      const result = decodeTLV8(buffer);

      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].type, 0x01);
      assert.deepStrictEqual(result[0].data, Buffer.from([0x42, 0x43, 0x44]));
    });

    it('should decode multiple TLV8 items', function () {
      const buffer = Buffer.from([0x01, 0x01, 0x42, 0x02, 0x02, 0x43, 0x44, 0x03, 0x03, 0x45, 0x46, 0x47]);

      const result = decodeTLV8(buffer);

      assert.strictEqual(result.length, 3);

      assert.strictEqual(result[0].type, 0x01);
      assert.deepStrictEqual(result[0].data, Buffer.from([0x42]));

      assert.strictEqual(result[1].type, 0x02);
      assert.deepStrictEqual(result[1].data, Buffer.from([0x43, 0x44]));

      assert.strictEqual(result[2].type, 0x03);
      assert.deepStrictEqual(result[2].data, Buffer.from([0x45, 0x46, 0x47]));
    });

    it('should handle empty buffer', function () {
      const buffer = Buffer.alloc(0);

      const result = decodeTLV8(buffer);

      assert.deepStrictEqual(result, []);
    });

    it('should decode fragmented data', function () {
      const buffer = Buffer.from([0x05, 0xff, ...Buffer.alloc(255, 0xab), 0x05, 0x01, 0xab]);

      const result = decodeTLV8(buffer);

      assert.strictEqual(result.length, 2);
      assert.strictEqual(result[0].type, 0x05);
      assert.deepStrictEqual(result[0].data, Buffer.alloc(255, 0xab));
      assert.strictEqual(result[1].type, 0x05);
      assert.deepStrictEqual(result[1].data, Buffer.from([0xab]));
    });

    it('should throw error for insufficient data for type and length', function () {
      const buffer = Buffer.from([0x01]);

      assert.throws(
        () => decodeTLV8(buffer),
        (err: any) =>
          err instanceof TLV8Error &&
          err.message.includes('Invalid TLV8: insufficient data for type and length at offset 0'),
      );
    });

    it('should throw error for insufficient data for value', function () {
      const buffer = Buffer.from([0x01, 0x05, 0x42, 0x43]);

      assert.throws(
        () => decodeTLV8(buffer),
        (err: any) =>
          err instanceof TLV8Error && err.message.includes('Invalid TLV8: insufficient data for value at offset 2'),
      );
    });
  });

  describe('decodeTLV8ToDict', function () {
    it('should decode to dictionary with unique types', function () {
      const buffer = Buffer.from([0x01, 0x01, 0x42, 0x02, 0x02, 0x43, 0x44, 0x03, 0x03, 0x45, 0x46, 0x47]);

      const result = decodeTLV8ToDict(buffer);

      assert.deepStrictEqual(result[0x01], Buffer.from([0x42]));
      assert.deepStrictEqual(result[0x02], Buffer.from([0x43, 0x44]));
      assert.deepStrictEqual(result[0x03], Buffer.from([0x45, 0x46, 0x47]));
    });

    it('should concatenate data for repeated types', function () {
      const buffer = Buffer.from([
        0x05,
        0xff,
        ...Buffer.alloc(255, 0xab),
        0x05,
        0x01,
        0xab,
        0x06,
        0x02,
        0xcc,
        0xdd,
        0x05,
        0x02,
        0xee,
        0xff,
      ]);

      const result = decodeTLV8ToDict(buffer);

      assert.deepStrictEqual(
        result[0x05],
        Buffer.concat([Buffer.alloc(255, 0xab), Buffer.from([0xab]), Buffer.from([0xee, 0xff])]),
      );

      assert.deepStrictEqual(result[0x06], Buffer.from([0xcc, 0xdd]));
    });

    it('should handle empty buffer', function () {
      const buffer = Buffer.alloc(0);

      const result = decodeTLV8ToDict(buffer);

      assert.deepStrictEqual(result, {});
    });

    it('should throw error for malformed data', function () {
      const buffer = Buffer.from([0x01, 0x05, 0x42]);

      assert.throws(() => decodeTLV8ToDict(buffer), TLV8Error);
    });
  });
});
