import { expect } from 'chai';

import { TLV8_MAX_FRAGMENT_SIZE } from '../../../../src/lib/apple-tv/constants.js';
import { encodeTLV8 } from '../../../../src/lib/apple-tv/tlv/encoder.js';
import type { TLV8Item } from '../../../../src/lib/apple-tv/types.js';

describe('TLV8 Encoder', function () {
  describe('encodeTLV8', function () {
    it('should encode a single TLV8 item', function () {
      const items: TLV8Item[] = [
        { type: 0x01, data: Buffer.from([0x42, 0x43, 0x44]) },
      ];

      const result = encodeTLV8(items);

      expect(result).to.deep.equal(Buffer.from([0x01, 0x03, 0x42, 0x43, 0x44]));
    });

    it('should encode multiple TLV8 items', function () {
      const items: TLV8Item[] = [
        { type: 0x01, data: Buffer.from([0x42]) },
        { type: 0x02, data: Buffer.from([0x43, 0x44]) },
        { type: 0x03, data: Buffer.from([0x45, 0x46, 0x47]) },
      ];

      const result = encodeTLV8(items);

      expect(result).to.deep.equal(
        Buffer.from([
          0x01, 0x01, 0x42, 0x02, 0x02, 0x43, 0x44, 0x03, 0x03, 0x45, 0x46,
          0x47,
        ]),
      );
    });

    it('should handle empty items array', function () {
      const items: TLV8Item[] = [];

      const result = encodeTLV8(items);

      expect(result).to.deep.equal(Buffer.alloc(0));
    });

    it('should fragment data exceeding TLV8_MAX_FRAGMENT_SIZE', function () {
      const largeData = Buffer.alloc(256, 0xab);
      const items: TLV8Item[] = [{ type: 0x05, data: largeData }];

      const result = encodeTLV8(items);

      expect(result.length).to.equal(
        2 + TLV8_MAX_FRAGMENT_SIZE + 2 + (256 - TLV8_MAX_FRAGMENT_SIZE),
      );
      expect(result[0]).to.equal(0x05);
      expect(result[1]).to.equal(TLV8_MAX_FRAGMENT_SIZE);
      expect(result.subarray(2, 2 + TLV8_MAX_FRAGMENT_SIZE)).to.deep.equal(
        Buffer.alloc(TLV8_MAX_FRAGMENT_SIZE, 0xab),
      );
      expect(result[2 + TLV8_MAX_FRAGMENT_SIZE]).to.equal(0x05);
      expect(result[3 + TLV8_MAX_FRAGMENT_SIZE]).to.equal(
        256 - TLV8_MAX_FRAGMENT_SIZE,
      );
      expect(result[4 + TLV8_MAX_FRAGMENT_SIZE]).to.equal(0xab);
    });

    it('should handle data exactly at TLV8_MAX_FRAGMENT_SIZE boundary', function () {
      const boundaryData = Buffer.alloc(TLV8_MAX_FRAGMENT_SIZE, 0xef);
      const items: TLV8Item[] = [{ type: 0x08, data: boundaryData }];

      const result = encodeTLV8(items);

      expect(result.length).to.equal(2 + TLV8_MAX_FRAGMENT_SIZE);
      expect(result[0]).to.equal(0x08);
      expect(result[1]).to.equal(TLV8_MAX_FRAGMENT_SIZE);
      expect(result.subarray(2)).to.deep.equal(boundaryData);
    });

    it('should handle all possible type values', function () {
      const items: TLV8Item[] = [
        { type: 0x00, data: Buffer.from([0x00]) },
        { type: 0x7f, data: Buffer.from([0x7f]) },
        { type: 0xff, data: Buffer.from([0xff]) },
      ];

      const result = encodeTLV8(items);

      expect(result).to.deep.equal(
        Buffer.from([0x00, 0x01, 0x00, 0x7f, 0x01, 0x7f, 0xff, 0x01, 0xff]),
      );
    });
  });
});
