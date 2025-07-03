import { expect } from 'chai';
import { describe, it } from 'mocha';

import { Opack2 } from '../../../../src/lib/apple-tv/encryption/opack2.js';
import { AppleTVError } from '../../../../src/lib/apple-tv/errors.js';

describe('Apple TV Encryption - Opack2', () => {
  describe('dumps - primitive types', () => {
    it('should encode null', () => {
      const result = Opack2.dumps(null);
      expect(result).to.deep.equal(Buffer.from([0x03]));
    });

    it('should encode undefined as null', () => {
      const result = Opack2.dumps(undefined);
      expect(result).to.deep.equal(Buffer.from([0x03]));
    });

    it('should encode boolean true', () => {
      const result = Opack2.dumps(true);
      expect(result).to.deep.equal(Buffer.from([0x01]));
    });

    it('should encode boolean false', () => {
      const result = Opack2.dumps(false);
      expect(result).to.deep.equal(Buffer.from([0x02]));
    });
  });

  describe('dumps - number encoding', () => {
    it('should encode small integers (0-39)', () => {
      expect(Opack2.dumps(0)).to.deep.equal(Buffer.from([0x08]));
      expect(Opack2.dumps(1)).to.deep.equal(Buffer.from([0x09]));
      expect(Opack2.dumps(39)).to.deep.equal(Buffer.from([0x2f]));
    });

    it('should encode single byte integers (40-255)', () => {
      const result = Opack2.dumps(40);
      expect(result).to.deep.equal(Buffer.from([0x30, 0x28]));
    });

    it('should encode 32-bit integers', () => {
      const result = Opack2.dumps(256);
      expect(result[0]).to.equal(0x32);
      expect(result.length).to.equal(5);
    });

    it('should encode negative numbers as float', () => {
      const result = Opack2.dumps(-1);
      expect(result[0]).to.equal(0x35);
      expect(result.length).to.equal(5);
    });

    it('should throw for numbers too large', () => {
      const tooLarge = Number.MAX_SAFE_INTEGER + 1;
      expect(() => Opack2.dumps(tooLarge)).to.throw(
        AppleTVError,
        'Number too large for OPACK2 encoding',
      );
    });
  });

  describe('dumps - string encoding', () => {
    it('should encode empty string', () => {
      const result = Opack2.dumps('');
      expect(result).to.deep.equal(Buffer.from([0x40]));
    });

    it('should encode short strings', () => {
      const result = Opack2.dumps('Hello');
      expect(result[0]).to.equal(0x45);
      expect(result.subarray(1).toString('utf8')).to.equal('Hello');
    });

    it('should handle UTF-8 strings correctly', () => {
      const utf8Str = '你好世界🌍';
      const result = Opack2.dumps(utf8Str);
      const byteLength = Buffer.from(utf8Str, 'utf8').length;
      expect(result[0]).to.equal(0x40 + byteLength);
      expect(result.subarray(1).toString('utf8')).to.equal(utf8Str);
    });
  });

  describe('dumps - buffer encoding', () => {
    it('should encode empty buffer', () => {
      const result = Opack2.dumps(Buffer.alloc(0));
      expect(result).to.deep.equal(Buffer.from([0x70]));
    });

    it('should encode short buffers', () => {
      const buf = Buffer.from([0x01, 0x02, 0x03]);
      const result = Opack2.dumps(buf);
      expect(result[0]).to.equal(0x73);
      expect(result.subarray(1)).to.deep.equal(buf);
    });
  });

  describe('dumps - array encoding', () => {
    it('should encode empty array', () => {
      const result = Opack2.dumps([]);
      expect(result).to.deep.equal(Buffer.from([0xd0]));
    });

    it('should encode small arrays', () => {
      const result = Opack2.dumps([1, 2, 3]);
      expect(result[0]).to.equal(0xd3);
      expect(result[1]).to.equal(0x09);
      expect(result[2]).to.equal(0x0a);
      expect(result[3]).to.equal(0x0b);
    });

    it('should encode large arrays', () => {
      const arr = Array(20).fill(true);
      const result = Opack2.dumps(arr);
      expect(result[0]).to.equal(0xdf);
      expect(result[result.length - 1]).to.equal(0x03);
    });
  });

  describe('dumps - object encoding', () => {
    it('should encode empty object', () => {
      const result = Opack2.dumps({});
      expect(result).to.deep.equal(Buffer.from([0xe0]));
    });

    it('should encode small objects', () => {
      const obj = { a: 1, b: 2 };
      const result = Opack2.dumps(obj);
      expect(result[0]).to.equal(0xe2);
    });

    it('should handle objects with undefined values', () => {
      const obj = { a: 1, b: undefined, c: 3 };
      const result = Opack2.dumps(obj);
      expect(result[0]).to.equal(0xe3);
    });

    it('should encode large objects', () => {
      const obj: Record<string, number> = {};
      for (let i = 0; i < 20; i++) {
        obj[`key${i}`] = i;
      }
      const result = Opack2.dumps(obj);
      expect(result[0]).to.equal(0xef);
      expect(result[result.length - 2]).to.equal(0x03);
      expect(result[result.length - 1]).to.equal(0x03);
    });
  });

  describe('dumps - error handling', () => {
    it('should throw for unsupported types - function', () => {
      const fn = () => {};
      expect(() => Opack2.dumps(fn as any)).to.throw(
        AppleTVError,
        'Unsupported type for OPACK2 serialization: function',
      );
    });

    it('should throw for unsupported types - symbol', () => {
      const sym = Symbol('test');
      expect(() => Opack2.dumps(sym as any)).to.throw(
        AppleTVError,
        'Unsupported type for OPACK2 serialization: symbol',
      );
    });
  });

  describe('dumps - complex structures', () => {
    it('should encode nested structures', () => {
      const complex = {
        users: [
          {
            id: 1,
            name: 'Alice',
            active: true,
            data: Buffer.from([0x01, 0x02, 0x03]),
          },
        ],
        config: {
          version: 3.14,
          features: ['feature1', 'feature2'],
        },
      };

      const result = Opack2.dumps(complex);
      expect(result).to.be.instanceOf(Buffer);
      expect(result.length).to.be.greaterThan(20);
    });
  });
});
