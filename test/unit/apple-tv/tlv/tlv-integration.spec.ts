import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {TLV8_MAX_FRAGMENT_SIZE} from '../../../../src/lib/apple-tv/constants.js';
import {decodeTLV8, decodeTLV8ToDict} from '../../../../src/lib/apple-tv/tlv/decoder.js';
import {encodeTLV8} from '../../../../src/lib/apple-tv/tlv/encoder.js';
import type {TLV8Item} from '../../../../src/lib/apple-tv/types.js';

describe('TLV8 Integration Tests', function () {
  describe('Round-trip encoding and decoding', function () {
    it('should maintain data integrity for simple items', function () {
      const originalItems: TLV8Item[] = [
        {type: 0x01, data: Buffer.from([0x42, 0x43, 0x44])},
        {type: 0x02, data: Buffer.from([0x45, 0x46])},
        {type: 0x03, data: Buffer.from([0x47])},
      ];

      const encoded = encodeTLV8(originalItems);
      const decoded = decodeTLV8(encoded);

      assert.deepStrictEqual(decoded, originalItems);
    });

    it('should handle fragmented data round-trip', function () {
      const largeData = Buffer.alloc(512);
      for (let i = 0; i < 512; i++) {
        largeData[i] = i % 256;
      }

      const originalItems: TLV8Item[] = [{type: 0x05, data: largeData}];

      const encoded = encodeTLV8(originalItems);
      const decoded = decodeTLV8(encoded);

      assert.strictEqual(decoded.length, 3);
      assert.strictEqual(decoded[0].type, 0x05);
      assert.strictEqual(decoded[1].type, 0x05);
      assert.strictEqual(decoded[2].type, 0x05);

      const reassembled = Buffer.concat(decoded.map((item) => item.data));
      assert.deepStrictEqual(reassembled, largeData);
    });

    it('should handle mixed fragmented and non-fragmented items', function () {
      const smallData = Buffer.from([0xaa, 0xbb]);
      const largeData = Buffer.alloc(300, 0xcc);
      const mediumData = Buffer.alloc(100, 0xdd);

      const originalItems: TLV8Item[] = [
        {type: 0x01, data: smallData},
        {type: 0x02, data: largeData},
        {type: 0x03, data: mediumData},
      ];

      const encoded = encodeTLV8(originalItems);
      const decoded = decodeTLV8(encoded);

      assert.strictEqual(decoded.length, 4);

      assert.deepStrictEqual(decoded[0], {type: 0x01, data: smallData});

      assert.strictEqual(decoded[1].type, 0x02);
      assert.strictEqual(decoded[1].data.length, 255);
      assert.strictEqual(decoded[2].type, 0x02);
      assert.strictEqual(decoded[2].data.length, 45);

      assert.deepStrictEqual(decoded[3], {type: 0x03, data: mediumData});
    });
  });

  describe('Round-trip with decodeTLV8ToDict', function () {
    it('should correctly reassemble fragmented data in dictionary', function () {
      const largeData = Buffer.alloc(512, 0xee);
      const originalItems: TLV8Item[] = [{type: 0x10, data: largeData}];

      const encoded = encodeTLV8(originalItems);
      const decodedDict = decodeTLV8ToDict(encoded);

      assert.deepStrictEqual(decodedDict[0x10], largeData);
    });

    it('should handle multiple types with fragmentation', function () {
      const data1 = Buffer.alloc(300, 0x11);
      const data2 = Buffer.alloc(50, 0x22);
      const data3 = Buffer.alloc(400, 0x33);

      const originalItems: TLV8Item[] = [
        {type: 0x01, data: data1},
        {type: 0x02, data: data2},
        {type: 0x03, data: data3},
      ];

      const encoded = encodeTLV8(originalItems);
      const decodedDict = decodeTLV8ToDict(encoded);

      assert.deepStrictEqual(decodedDict[0x01], data1);
      assert.deepStrictEqual(decodedDict[0x02], data2);
      assert.deepStrictEqual(decodedDict[0x03], data3);
    });
  });

  describe('Edge cases', function () {
    it('should handle maximum size data at boundary', function () {
      const boundaryData = Buffer.alloc(TLV8_MAX_FRAGMENT_SIZE);
      for (let i = 0; i < TLV8_MAX_FRAGMENT_SIZE; i++) {
        boundaryData[i] = i % 256;
      }

      const items: TLV8Item[] = [{type: 0x42, data: boundaryData}];

      const encoded = encodeTLV8(items);
      const decoded = decodeTLV8(encoded);

      assert.strictEqual(decoded.length, 1);
      assert.deepStrictEqual(decoded[0], items[0]);
    });

    it('should handle empty items array', function () {
      const items: TLV8Item[] = [];

      const encoded = encodeTLV8(items);
      const decoded = decodeTLV8(encoded);
      const decodedDict = decodeTLV8ToDict(encoded);

      assert.deepStrictEqual(encoded, Buffer.alloc(0));
      assert.deepStrictEqual(decoded, []);
      assert.deepStrictEqual(decodedDict, {});
    });

    it('should preserve exact byte sequences through round-trip', function () {
      const problematicData = Buffer.from([
        0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0x01, 0x02, 0x03, 0x00, 0xff, 0x00, 0xff,
      ]);

      const items: TLV8Item[] = [{type: 0x77, data: problematicData}];

      const encoded = encodeTLV8(items);
      const decoded = decodeTLV8(encoded);

      assert.deepStrictEqual(decoded[0].data, problematicData);
    });
  });
});
