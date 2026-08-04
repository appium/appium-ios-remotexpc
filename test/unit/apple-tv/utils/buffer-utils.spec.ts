import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {
  bigIntToBuffer,
  bigIntToMinimalBuffer,
  bufferToBigInt,
  modPow,
} from '../../../../src/lib/apple-tv/utils/buffer-utils.js';

describe('buffer-utils', () => {
  describe('bigIntToBuffer', () => {
    it('should convert bigint to fixed-length buffer', () => {
      const result = bigIntToBuffer(255n, 4);
      assert.deepStrictEqual(result, Buffer.from([0x00, 0x00, 0x00, 0xff]));
    });

    it('should throw error for negative values', () => {
      assert.throws(
        () => bigIntToBuffer(-1n, 4),
        (err: any) => err instanceof RangeError && err.message.includes('Negative values not supported'),
      );
    });

    it('should throw error when value is too large', () => {
      assert.throws(
        () => bigIntToBuffer(0xffffn, 1),
        (err: any) => err instanceof RangeError && err.message.includes('too large to fit'),
      );
    });
  });

  describe('bufferToBigInt', () => {
    it('should convert buffer to bigint', () => {
      const buffer = Buffer.from([0x01, 0x02, 0x03]);
      const result = bufferToBigInt(buffer);
      assert.strictEqual(result, 0x010203n);
    });
  });

  describe('bigIntToMinimalBuffer', () => {
    it('should convert bigint to minimal buffer', () => {
      const result = bigIntToMinimalBuffer(255n);
      assert.deepStrictEqual(result, Buffer.from([0xff]));
    });

    it('should throw error for negative values', () => {
      assert.throws(
        () => bigIntToMinimalBuffer(-1n),
        (err: any) => err instanceof RangeError && err.message.includes('Negative values not supported'),
      );
    });
  });

  describe('modPow', () => {
    it('should compute modular exponentiation', () => {
      const result = modPow(2n, 3n, 5n);
      assert.strictEqual(result, 3n); // (2^3) % 5 = 8 % 5 = 3
    });

    it('should throw error for zero modulus', () => {
      assert.throws(
        () => modPow(2n, 3n, 0n),
        (err: any) => err instanceof RangeError && err.message.includes('Modulus must be non-zero'),
      );
    });

    it('should throw error for negative exponent', () => {
      assert.throws(
        () => modPow(2n, -1n, 5n),
        (err: any) => err instanceof RangeError && err.message.includes('Negative exponents not supported'),
      );
    });
  });
});
