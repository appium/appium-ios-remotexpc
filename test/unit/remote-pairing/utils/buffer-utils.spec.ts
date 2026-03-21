import { expect } from 'chai';

import {
  bigIntToBuffer,
  bigIntToMinimalBuffer,
  bufferToBigInt,
  modPow,
} from '../../../../src/lib/remote-pairing/utils/buffer-utils.js';

describe('buffer-utils', function () {
  describe('bigIntToBuffer', function () {
    it('should convert bigint to fixed-length buffer', function () {
      const result = bigIntToBuffer(255n, 4);
      expect(result).to.deep.equal(Buffer.from([0x00, 0x00, 0x00, 0xff]));
    });

    it('should throw error for negative values', function () {
      expect(() => bigIntToBuffer(-1n, 4)).to.throw(
        RangeError,
        'Negative values not supported',
      );
    });

    it('should throw error when value is too large', function () {
      expect(() => bigIntToBuffer(0xffffn, 1)).to.throw(
        RangeError,
        'too large to fit',
      );
    });
  });

  describe('bufferToBigInt', function () {
    it('should convert buffer to bigint', function () {
      const buffer = Buffer.from([0x01, 0x02, 0x03]);
      const result = bufferToBigInt(buffer);
      expect(result).to.equal(0x010203n);
    });
  });

  describe('bigIntToMinimalBuffer', function () {
    it('should convert bigint to minimal buffer', function () {
      const result = bigIntToMinimalBuffer(255n);
      expect(result).to.deep.equal(Buffer.from([0xff]));
    });

    it('should throw error for negative values', function () {
      expect(() => bigIntToMinimalBuffer(-1n)).to.throw(
        RangeError,
        'Negative values not supported',
      );
    });
  });

  describe('modPow', function () {
    it('should compute modular exponentiation', function () {
      const result = modPow(2n, 3n, 5n);
      expect(result).to.equal(3n); // (2^3) % 5 = 8 % 5 = 3
    });

    it('should throw error for zero modulus', function () {
      expect(() => modPow(2n, 3n, 0n)).to.throw(
        RangeError,
        'Modulus must be non-zero',
      );
    });

    it('should throw error for negative exponent', function () {
      expect(() => modPow(2n, -1n, 5n)).to.throw(
        RangeError,
        'Negative exponents not supported',
      );
    });
  });
});
