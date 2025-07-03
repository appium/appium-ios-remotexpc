import { expect } from 'chai';
import { describe, it } from 'mocha';

import {
  type HKDFParams,
  hkdf,
} from '../../../../src/lib/apple-tv/encryption/hkdf.js';
import { CryptographyError } from '../../../../src/lib/apple-tv/errors.js';

describe('Apple TV Encryption - HKDF', () => {
  const defaultIkm = Buffer.from('input key material', 'utf8');
  const defaultSalt = Buffer.from('salt value', 'utf8');
  const defaultInfo = Buffer.from('info string', 'utf8');

  describe('basic functionality', () => {
    it('should derive key with all parameters', () => {
      const params: HKDFParams = {
        ikm: defaultIkm,
        salt: defaultSalt,
        info: defaultInfo,
        length: 32,
      };

      const result = hkdf(params);

      expect(result).to.be.instanceOf(Buffer);
      expect(result.length).to.equal(32);
    });

    it('should derive key with null salt', () => {
      const params: HKDFParams = {
        ikm: defaultIkm,
        salt: null,
        info: defaultInfo,
        length: 32,
      };

      const result = hkdf(params);

      expect(result).to.be.instanceOf(Buffer);
      expect(result.length).to.equal(32);
    });

    it('should produce consistent results for same inputs', () => {
      const params: HKDFParams = {
        ikm: defaultIkm,
        salt: defaultSalt,
        info: defaultInfo,
        length: 48,
      };

      const result1 = hkdf(params);
      const result2 = hkdf(params);

      expect(result1.equals(result2)).to.be.true;
    });

    it('should produce different results for different IKM', () => {
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

      expect(result1.equals(result2)).to.be.false;
    });
  });

  describe('output length variations', () => {
    it('should handle minimum length (1 byte)', () => {
      const params: HKDFParams = {
        ikm: defaultIkm,
        salt: defaultSalt,
        info: defaultInfo,
        length: 1,
      };
      const result = hkdf(params);

      expect(result.length).to.equal(1);
    });

    it('should handle maximum allowed length (255 * 64 = 16320 bytes)', () => {
      const params: HKDFParams = {
        ikm: defaultIkm,
        salt: defaultSalt,
        info: defaultInfo,
        length: 16320,
      };
      const result = hkdf(params);

      expect(result.length).to.equal(16320);
    });
  });

  describe('error handling', () => {
    it('should throw when IKM is empty', () => {
      const params: HKDFParams = {
        ikm: Buffer.alloc(0),
        salt: defaultSalt,
        info: defaultInfo,
        length: 32,
      };

      expect(() => hkdf(params)).to.throw(
        CryptographyError,
        'Input key material (IKM) cannot be empty',
      );
    });

    it('should throw when info is missing', () => {
      const params: HKDFParams = {
        ikm: defaultIkm,
        salt: defaultSalt,
        info: null as any,
        length: 32,
      };

      expect(() => hkdf(params)).to.throw(
        CryptographyError,
        'Info parameter is required',
      );
    });

    it('should throw when length is zero', () => {
      const params: HKDFParams = {
        ikm: defaultIkm,
        salt: defaultSalt,
        info: defaultInfo,
        length: 0,
      };

      expect(() => hkdf(params)).to.throw(
        CryptographyError,
        'Output length must be positive',
      );
    });

    it('should throw when length exceeds maximum', () => {
      const params: HKDFParams = {
        ikm: defaultIkm,
        salt: defaultSalt,
        info: defaultInfo,
        length: 16321,
      };

      expect(() => hkdf(params)).to.throw(
        CryptographyError,
        'Output length cannot exceed 16320 bytes',
      );
    });
  });
});
