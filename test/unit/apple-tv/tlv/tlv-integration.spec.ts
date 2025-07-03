import { expect } from 'chai';

import { TLV8_MAX_FRAGMENT_SIZE } from '../../../../src/lib/apple-tv/constants.js';
import {
  decodeTLV8,
  decodeTLV8ToDict,
} from '../../../../src/lib/apple-tv/tlv/decoder.js';
import { encodeTLV8 } from '../../../../src/lib/apple-tv/tlv/encoder.js';
import type { TLV8Item } from '../../../../src/lib/apple-tv/types.js';

describe('TLV8 Integration Tests', function () {
  describe('Round-trip encoding and decoding', function () {
    it('should maintain data integrity for simple items', function () {
      const originalItems: TLV8Item[] = [
        { type: 0x01, data: Buffer.from([0x42, 0x43, 0x44]) },
        { type: 0x02, data: Buffer.from([0x45, 0x46]) },
        { type: 0x03, data: Buffer.from([0x47]) },
      ];

      const encoded = encodeTLV8(originalItems);
      const decoded = decodeTLV8(encoded);

      expect(decoded).to.deep.equal(originalItems);
    });

    it('should handle fragmented data round-trip', function () {
      const largeData = Buffer.alloc(512);
      for (let i = 0; i < 512; i++) {
        largeData[i] = i % 256;
      }

      const originalItems: TLV8Item[] = [{ type: 0x05, data: largeData }];

      const encoded = encodeTLV8(originalItems);
      const decoded = decodeTLV8(encoded);

      expect(decoded).to.have.lengthOf(3);
      expect(decoded[0].type).to.equal(0x05);
      expect(decoded[1].type).to.equal(0x05);
      expect(decoded[2].type).to.equal(0x05);

      const reassembled = Buffer.concat(decoded.map((item) => item.data));
      expect(reassembled).to.deep.equal(largeData);
    });

    it('should handle mixed fragmented and non-fragmented items', function () {
      const smallData = Buffer.from([0xaa, 0xbb]);
      const largeData = Buffer.alloc(300, 0xcc);
      const mediumData = Buffer.alloc(100, 0xdd);

      const originalItems: TLV8Item[] = [
        { type: 0x01, data: smallData },
        { type: 0x02, data: largeData },
        { type: 0x03, data: mediumData },
      ];

      const encoded = encodeTLV8(originalItems);
      const decoded = decodeTLV8(encoded);

      expect(decoded).to.have.lengthOf(4);

      expect(decoded[0]).to.deep.equal({ type: 0x01, data: smallData });

      expect(decoded[1].type).to.equal(0x02);
      expect(decoded[1].data.length).to.equal(255);
      expect(decoded[2].type).to.equal(0x02);
      expect(decoded[2].data.length).to.equal(45);

      expect(decoded[3]).to.deep.equal({ type: 0x03, data: mediumData });
    });
  });

  describe('Round-trip with decodeTLV8ToDict', function () {
    it('should correctly reassemble fragmented data in dictionary', function () {
      const largeData = Buffer.alloc(512, 0xee);
      const originalItems: TLV8Item[] = [{ type: 0x10, data: largeData }];

      const encoded = encodeTLV8(originalItems);
      const decodedDict = decodeTLV8ToDict(encoded);

      expect(decodedDict[0x10]).to.deep.equal(largeData);
    });

    it('should handle multiple types with fragmentation', function () {
      const data1 = Buffer.alloc(300, 0x11);
      const data2 = Buffer.alloc(50, 0x22);
      const data3 = Buffer.alloc(400, 0x33);

      const originalItems: TLV8Item[] = [
        { type: 0x01, data: data1 },
        { type: 0x02, data: data2 },
        { type: 0x03, data: data3 },
      ];

      const encoded = encodeTLV8(originalItems);
      const decodedDict = decodeTLV8ToDict(encoded);

      expect(decodedDict[0x01]).to.deep.equal(data1);
      expect(decodedDict[0x02]).to.deep.equal(data2);
      expect(decodedDict[0x03]).to.deep.equal(data3);
    });
  });

  describe('Edge cases', function () {
    it('should handle maximum size data at boundary', function () {
      const boundaryData = Buffer.alloc(TLV8_MAX_FRAGMENT_SIZE);
      for (let i = 0; i < TLV8_MAX_FRAGMENT_SIZE; i++) {
        boundaryData[i] = i % 256;
      }

      const items: TLV8Item[] = [{ type: 0x42, data: boundaryData }];

      const encoded = encodeTLV8(items);
      const decoded = decodeTLV8(encoded);

      expect(decoded).to.have.lengthOf(1);
      expect(decoded[0]).to.deep.equal(items[0]);
    });

    it('should handle empty items array', function () {
      const items: TLV8Item[] = [];

      const encoded = encodeTLV8(items);
      const decoded = decodeTLV8(encoded);
      const decodedDict = decodeTLV8ToDict(encoded);

      expect(encoded).to.deep.equal(Buffer.alloc(0));
      expect(decoded).to.deep.equal([]);
      expect(decodedDict).to.deep.equal({});
    });

    it('should preserve exact byte sequences through round-trip', function () {
      const problematicData = Buffer.from([
        0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0x01, 0x02, 0x03, 0x00, 0xff, 0x00,
        0xff,
      ]);

      const items: TLV8Item[] = [{ type: 0x77, data: problematicData }];

      const encoded = encodeTLV8(items);
      const decoded = decodeTLV8(encoded);

      expect(decoded[0].data).to.deep.equal(problematicData);
    });
  });
});
