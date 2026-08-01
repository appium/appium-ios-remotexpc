import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {Opack2} from '../../../../src/lib/apple-tv/encryption/opack2.js';
import {AppleTVError} from '../../../../src/lib/apple-tv/errors.js';

describe('Apple TV Encryption - Opack2', function () {
  describe('loads', function () {
    it('should decode primitive types', function () {
      assert.strictEqual(Opack2.loads(Buffer.from([0x03])), null);
      assert.strictEqual(Opack2.loads(Buffer.from([0x01])), true);
      assert.strictEqual(Opack2.loads(Buffer.from([0x02])), false);
      assert.strictEqual(Opack2.loads(Buffer.from([0x0a])), 2);
    });

    it('should decode an Apple TV M6 INFO-shaped payload', function () {
      const info = Opack2.dumps({
        remotepairing_serial_number: 'SYNTHETIC123',
        remotepairing_udid: 'synthetic-remote-pairing-udid',
        model: 'AppleTV-Test',
        name: 'Test Apple TV',
      });

      const decoded = Opack2.loads(info) as Record<string, unknown>;

      assert.strictEqual(decoded.remotepairing_udid, 'synthetic-remote-pairing-udid');
      assert.strictEqual(decoded.remotepairing_serial_number, 'SYNTHETIC123');
      assert.strictEqual(decoded.model, 'AppleTV-Test');
      assert.strictEqual(decoded.name, 'Test Apple TV');
    });

    it('should round-trip objects encoded with dumps', function () {
      const value = {
        name: 'Apple TV',
        identifier: 'synthetic-remote-pairing-udid',
        data: Buffer.from([1, 2, 3]),
      };

      assert.deepStrictEqual(Opack2.loads(Opack2.dumps(value)), value);
    });
  });

  describe('dumps - primitive types', function () {
    it('should encode null', function () {
      const result = Opack2.dumps(null);
      assert.deepStrictEqual(result, Buffer.from([0x03]));
    });

    it('should encode undefined as null', function () {
      const result = Opack2.dumps(undefined);
      assert.deepStrictEqual(result, Buffer.from([0x03]));
    });

    it('should encode boolean true', function () {
      const result = Opack2.dumps(true);
      assert.deepStrictEqual(result, Buffer.from([0x01]));
    });

    it('should encode boolean false', function () {
      const result = Opack2.dumps(false);
      assert.deepStrictEqual(result, Buffer.from([0x02]));
    });
  });

  describe('dumps - number encoding', function () {
    it('should encode small integers (0-39)', function () {
      assert.deepStrictEqual(Opack2.dumps(0), Buffer.from([0x08]));
      assert.deepStrictEqual(Opack2.dumps(1), Buffer.from([0x09]));
      assert.deepStrictEqual(Opack2.dumps(39), Buffer.from([0x2f]));
    });

    it('should encode single byte integers (40-255)', function () {
      const result = Opack2.dumps(40);
      assert.deepStrictEqual(result, Buffer.from([0x30, 0x28]));
    });

    it('should encode 32-bit integers', function () {
      const result = Opack2.dumps(256);
      assert.strictEqual(result[0], 0x32);
      assert.strictEqual(result.length, 5);
    });

    it('should encode negative numbers as float', function () {
      const result = Opack2.dumps(-1);
      assert.strictEqual(result[0], 0x35);
      assert.strictEqual(result.length, 5);
    });

    it('should throw for numbers too large', function () {
      const tooLarge = Number.MAX_SAFE_INTEGER + 1;
      assert.throws(
        () => Opack2.dumps(tooLarge),
        (err: any) => err instanceof AppleTVError && err.message.includes('Number too large for OPACK2 encoding'),
      );
    });
  });

  describe('dumps - string encoding', function () {
    it('should encode empty string', function () {
      const result = Opack2.dumps('');
      assert.deepStrictEqual(result, Buffer.from([0x40]));
    });

    it('should encode short strings', function () {
      const result = Opack2.dumps('Hello');
      assert.strictEqual(result[0], 0x45);
      assert.strictEqual(result.subarray(1).toString('utf8'), 'Hello');
    });

    it('should handle UTF-8 strings correctly', function () {
      const utf8Str = '你好世界🌍';
      const result = Opack2.dumps(utf8Str);
      const byteLength = Buffer.from(utf8Str, 'utf8').length;
      assert.strictEqual(result[0], 0x40 + byteLength);
      assert.strictEqual(result.subarray(1).toString('utf8'), utf8Str);
    });
  });

  describe('dumps - buffer encoding', function () {
    it('should encode empty buffer', function () {
      const result = Opack2.dumps(Buffer.alloc(0));
      assert.deepStrictEqual(result, Buffer.from([0x70]));
    });

    it('should encode short buffers', function () {
      const buf = Buffer.from([0x01, 0x02, 0x03]);
      const result = Opack2.dumps(buf);
      assert.strictEqual(result[0], 0x73);
      assert.deepStrictEqual(result.subarray(1), buf);
    });
  });

  describe('dumps - array encoding', function () {
    it('should encode empty array', function () {
      const result = Opack2.dumps([]);
      assert.deepStrictEqual(result, Buffer.from([0xd0]));
    });

    it('should encode small arrays', function () {
      const result = Opack2.dumps([1, 2, 3]);
      assert.strictEqual(result[0], 0xd3);
      assert.strictEqual(result[1], 0x09);
      assert.strictEqual(result[2], 0x0a);
      assert.strictEqual(result[3], 0x0b);
    });

    it('should encode large arrays', function () {
      const arr = Array(20).fill(true);
      const result = Opack2.dumps(arr);
      assert.strictEqual(result[0], 0xdf);
      assert.strictEqual(result[result.length - 1], 0x03);
    });
  });

  describe('dumps - object encoding', function () {
    it('should encode empty object', function () {
      const result = Opack2.dumps({});
      assert.deepStrictEqual(result, Buffer.from([0xe0]));
    });

    it('should encode small objects', function () {
      const obj = {a: 1, b: 2};
      const result = Opack2.dumps(obj);
      assert.strictEqual(result[0], 0xe2);
    });

    it('should handle objects with undefined values', function () {
      const obj: {a: number; b: undefined; c: number} = {
        a: 1,
        b: undefined,
        c: 3,
      };
      const result = Opack2.dumps(obj);
      assert.strictEqual(result[0], 0xe3);
    });

    it('should encode large objects', function () {
      const obj: Record<string, number> = {};
      for (let i = 0; i < 20; i++) {
        obj[`key${i}`] = i;
      }
      const result = Opack2.dumps(obj);
      assert.strictEqual(result[0], 0xef);
      assert.strictEqual(result[result.length - 2], 0x03);
      assert.strictEqual(result[result.length - 1], 0x03);
    });
  });

  describe('dumps - error handling', function () {
    it('should throw for unsupported types - function', function () {
      const fn = () => {};
      assert.throws(
        () => Opack2.dumps(fn as any),
        (err: any) =>
          err instanceof AppleTVError && err.message.includes('Unsupported type for OPACK2 serialization: function'),
      );
    });

    it('should throw for unsupported types - symbol', function () {
      const sym = Symbol('test');
      assert.throws(
        () => Opack2.dumps(sym as any),
        (err: any) =>
          err instanceof AppleTVError && err.message.includes('Unsupported type for OPACK2 serialization: symbol'),
      );
    });
  });

  describe('dumps - complex structures', function () {
    it('should encode nested structures', function () {
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
      assert.ok(result instanceof Buffer);
      assert.ok(result.length > 20);
    });
  });
});
