import { expect } from 'chai';

import { TLV8Error } from '../../../../src/lib/apple-tv/errors.js';
import {
  decodeTLV8,
  decodeTLV8ToDict,
} from '../../../../src/lib/apple-tv/tlv/decoder.js';

describe('TLV8 Decoder', function () {
  describe('decodeTLV8', function () {
    it('should decode a single TLV8 item', function () {
      const buffer = Buffer.from([0x01, 0x03, 0x42, 0x43, 0x44]);

      const result = decodeTLV8(buffer);

      expect(result).to.have.lengthOf(1);
      expect(result[0].type).to.equal(0x01);
      expect(result[0].data).to.deep.equal(Buffer.from([0x42, 0x43, 0x44]));
    });

    it('should decode multiple TLV8 items', function () {
      const buffer = Buffer.from([
        0x01, 0x01, 0x42, 0x02, 0x02, 0x43, 0x44, 0x03, 0x03, 0x45, 0x46, 0x47,
      ]);

      const result = decodeTLV8(buffer);

      expect(result).to.have.lengthOf(3);

      expect(result[0].type).to.equal(0x01);
      expect(result[0].data).to.deep.equal(Buffer.from([0x42]));

      expect(result[1].type).to.equal(0x02);
      expect(result[1].data).to.deep.equal(Buffer.from([0x43, 0x44]));

      expect(result[2].type).to.equal(0x03);
      expect(result[2].data).to.deep.equal(Buffer.from([0x45, 0x46, 0x47]));
    });

    it('should handle empty buffer', function () {
      const buffer = Buffer.alloc(0);

      const result = decodeTLV8(buffer);

      expect(result).to.deep.equal([]);
    });

    it('should decode fragmented data', function () {
      const buffer = Buffer.from([
        0x05,
        0xff,
        ...Buffer.alloc(255, 0xab),
        0x05,
        0x01,
        0xab,
      ]);

      const result = decodeTLV8(buffer);

      expect(result).to.have.lengthOf(2);
      expect(result[0].type).to.equal(0x05);
      expect(result[0].data).to.deep.equal(Buffer.alloc(255, 0xab));
      expect(result[1].type).to.equal(0x05);
      expect(result[1].data).to.deep.equal(Buffer.from([0xab]));
    });

    it('should throw error for insufficient data for type and length', function () {
      const buffer = Buffer.from([0x01]);

      expect(() => decodeTLV8(buffer)).to.throw(
        TLV8Error,
        'Invalid TLV8: insufficient data for type and length at offset 0',
      );
    });

    it('should throw error for insufficient data for value', function () {
      const buffer = Buffer.from([0x01, 0x05, 0x42, 0x43]);

      expect(() => decodeTLV8(buffer)).to.throw(
        TLV8Error,
        'Invalid TLV8: insufficient data for value at offset 2',
      );
    });
  });

  describe('decodeTLV8ToDict', function () {
    it('should decode to dictionary with unique types', function () {
      const buffer = Buffer.from([
        0x01, 0x01, 0x42, 0x02, 0x02, 0x43, 0x44, 0x03, 0x03, 0x45, 0x46, 0x47,
      ]);

      const result = decodeTLV8ToDict(buffer);

      expect(result[0x01]).to.deep.equal(Buffer.from([0x42]));
      expect(result[0x02]).to.deep.equal(Buffer.from([0x43, 0x44]));
      expect(result[0x03]).to.deep.equal(Buffer.from([0x45, 0x46, 0x47]));
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

      expect(result[0x05]).to.deep.equal(
        Buffer.concat([
          Buffer.alloc(255, 0xab),
          Buffer.from([0xab]),
          Buffer.from([0xee, 0xff]),
        ]),
      );

      expect(result[0x06]).to.deep.equal(Buffer.from([0xcc, 0xdd]));
    });

    it('should handle empty buffer', function () {
      const buffer = Buffer.alloc(0);

      const result = decodeTLV8ToDict(buffer);

      expect(result).to.deep.equal({});
    });

    it('should throw error for malformed data', function () {
      const buffer = Buffer.from([0x01, 0x05, 0x42]);

      expect(() => decodeTLV8ToDict(buffer)).to.throw(TLV8Error);
    });
  });
});
