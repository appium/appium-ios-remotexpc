import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {type HKDFParams, hkdf} from '../../../../src/lib/apple-tv/encryption/hkdf.js';
import {CryptographyError} from '../../../../src/lib/apple-tv/errors.js';

describe('Apple TV Encryption - HKDF', function () {
  const defaultIkm = Buffer.from('input key material', 'utf8');
  const defaultSalt = Buffer.from('salt value', 'utf8');
  const defaultInfo = Buffer.from('info string', 'utf8');

  describe('basic functionality', function () {
    it('should derive key with all parameters', function () {
      const params: HKDFParams = {
        ikm: defaultIkm,
        salt: defaultSalt,
        info: defaultInfo,
        length: 32,
      };

      const result = hkdf(params);

      assert.ok(result instanceof Buffer);
      assert.strictEqual(result.length, 32);
    });

    it('should derive key with null salt', function () {
      const params: HKDFParams = {
        ikm: defaultIkm,
        salt: null,
        info: defaultInfo,
        length: 32,
      };

      const result = hkdf(params);

      assert.ok(result instanceof Buffer);
      assert.strictEqual(result.length, 32);
    });

    it('should produce consistent results for same inputs', function () {
      const params: HKDFParams = {
        ikm: defaultIkm,
        salt: defaultSalt,
        info: defaultInfo,
        length: 48,
      };

      const result1 = hkdf(params);
      const result2 = hkdf(params);

      assert.strictEqual(result1.equals(result2), true);
    });

    it('should produce different results for different IKM', function () {
      const params1: HKDFParams = {
        ikm: Buffer.from('ikm1', 'utf8'),
        salt: defaultSalt,
        info: defaultInfo,
        length: 32,
      };

      const params2: HKDFParams = {
        ikm: Buffer.from('ikm2', 'utf8'),
        salt: defaultSalt,
        info: defaultInfo,
        length: 32,
      };

      const result1 = hkdf(params1);
      const result2 = hkdf(params2);

      assert.strictEqual(result1.equals(result2), false);
    });
  });

  describe('output length variations', function () {
    it('should handle minimum length (1 byte)', function () {
      const params: HKDFParams = {
        ikm: defaultIkm,
        salt: defaultSalt,
        info: defaultInfo,
        length: 1,
      };
      const result = hkdf(params);

      assert.strictEqual(result.length, 1);
    });

    it('should handle maximum allowed length (255 * 64 = 16320 bytes)', function () {
      const params: HKDFParams = {
        ikm: defaultIkm,
        salt: defaultSalt,
        info: defaultInfo,
        length: 16320,
      };
      const result = hkdf(params);

      assert.strictEqual(result.length, 16320);
    });
  });

  describe('error handling', function () {
    it('should throw when IKM is empty', function () {
      const params: HKDFParams = {
        ikm: Buffer.alloc(0),
        salt: defaultSalt,
        info: defaultInfo,
        length: 32,
      };

      assert.throws(
        () => hkdf(params),
        (err: any) =>
          err instanceof CryptographyError && err.message.includes('Input key material (IKM) cannot be empty'),
      );
    });

    it('should throw when info is missing', function () {
      const params: HKDFParams = {
        ikm: defaultIkm,
        salt: defaultSalt,
        info: null as any,
        length: 32,
      };

      assert.throws(
        () => hkdf(params),
        (err: any) => err instanceof CryptographyError && err.message.includes('Info parameter is required'),
      );
    });

    it('should throw when length is zero', function () {
      const params: HKDFParams = {
        ikm: defaultIkm,
        salt: defaultSalt,
        info: defaultInfo,
        length: 0,
      };

      assert.throws(
        () => hkdf(params),
        (err: any) => err instanceof CryptographyError && err.message.includes('Output length must be positive'),
      );
    });

    it('should throw when length exceeds maximum', function () {
      const params: HKDFParams = {
        ikm: defaultIkm,
        salt: defaultSalt,
        info: defaultInfo,
        length: 16321,
      };

      assert.throws(
        () => hkdf(params),
        (err: any) =>
          err instanceof CryptographyError && err.message.includes('Output length cannot exceed 16320 bytes'),
      );
    });
  });
});
