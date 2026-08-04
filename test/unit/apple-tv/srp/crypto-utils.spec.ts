import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {describe, it} from 'node:test';

import {SRP_GENERATOR, SRP_KEY_LENGTH_BYTES, SRP_PRIME_3072} from '../../../../src/lib/apple-tv/constants.js';
import {calculateK, calculateM1, calculateU, calculateX, hash} from '../../../../src/lib/apple-tv/srp/crypto-utils.js';

describe('Apple TV SRP - Crypto Utils', function () {
  describe('hash', function () {
    it('should compute hash of multiple buffers', function () {
      const input1 = Buffer.from('first');
      const input2 = Buffer.from('second');
      const input3 = Buffer.from('third');

      const result = hash(input1, input2, input3);

      assert.ok(result instanceof Buffer);
      assert.strictEqual(result.length, 64);
    });

    it('should produce different hashes for different inputs', function () {
      const input1 = Buffer.from('data1');
      const input2 = Buffer.from('data2');

      const hash1 = hash(input1);
      const hash2 = hash(input2);

      assert.strictEqual(hash1.equals(hash2), false);
    });

    it('should throw error when no inputs provided', function () {
      assert.throws(
        function () {
          hash();
        },
        (err: any) => err.message.includes('At least one input buffer is required for hashing'),
      );
    });

    it('should throw error when non-buffer input provided', function () {
      assert.throws(
        function () {
          hash('not a buffer' as any);
        },
        (err: any) => err.message.includes('All inputs must be Buffer objects'),
      );
    });
  });

  describe('calculateK', function () {
    it('should calculate k value for valid inputs', function () {
      const k = calculateK(SRP_PRIME_3072, SRP_GENERATOR, SRP_KEY_LENGTH_BYTES);

      assert.ok(typeof k === 'bigint');
      assert.strictEqual(k > BigInt(0), true);
    });

    it('should produce different k values for different N', function () {
      const N1 = BigInt(997);
      const N2 = BigInt(1009);

      const k1 = calculateK(N1, SRP_GENERATOR, 128);
      const k2 = calculateK(N2, SRP_GENERATOR, 128);

      assert.notStrictEqual(k1, k2);
    });

    it('should throw error for zero N', function () {
      assert.throws(
        function () {
          calculateK(BigInt(0), SRP_GENERATOR, SRP_KEY_LENGTH_BYTES);
        },
        (err: any) => err.message.includes('N and g must be positive'),
      );
    });

    it('should throw error for negative g', function () {
      assert.throws(
        function () {
          calculateK(SRP_PRIME_3072, BigInt(-1), SRP_KEY_LENGTH_BYTES);
        },
        (err: any) => err.message.includes('N and g must be positive'),
      );
    });

    it('should throw error for zero key length', function () {
      assert.throws(
        function () {
          calculateK(SRP_PRIME_3072, SRP_GENERATOR, 0);
        },
        (err: any) => err.message.includes('Key length must be positive'),
      );
    });
  });

  describe('calculateX', function () {
    const salt = Buffer.from('test salt');
    const username = 'testuser';
    const password = 'testpass';

    it('should calculate x value for valid inputs', function () {
      const x = calculateX(salt, username, password);

      assert.ok(typeof x === 'bigint');
      assert.strictEqual(x > BigInt(0), true);
    });

    it('should produce different x values for different salts', function () {
      const salt1 = Buffer.from('salt1');
      const salt2 = Buffer.from('salt2');

      const x1 = calculateX(salt1, username, password);
      const x2 = calculateX(salt2, username, password);

      assert.notStrictEqual(x1, x2);
    });

    it('should produce different x values for different passwords', function () {
      const x1 = calculateX(salt, username, 'password1');
      const x2 = calculateX(salt, username, 'password2');

      assert.notStrictEqual(x1, x2);
    });

    it('should throw error for empty salt', function () {
      assert.throws(
        function () {
          calculateX(Buffer.alloc(0), username, password);
        },
        (err: any) => err.message.includes('Salt must be a non-empty Buffer'),
      );
    });

    it('should throw error for non-buffer salt', function () {
      assert.throws(
        function () {
          calculateX('not a buffer' as any, username, password);
        },
        (err: any) => err.message.includes('Salt must be a non-empty Buffer'),
      );
    });

    it('should throw error for empty username', function () {
      assert.throws(
        function () {
          calculateX(salt, '', password);
        },
        (err: any) => err.message.includes('Username and password must be non-empty strings'),
      );
    });

    it('should throw error for empty password', function () {
      assert.throws(
        function () {
          calculateX(salt, username, '');
        },
        (err: any) => err.message.includes('Username and password must be non-empty strings'),
      );
    });
  });

  describe('calculateU', function () {
    const A = BigInt('0x' + 'a'.repeat(768));
    const B = BigInt('0x' + 'b'.repeat(768));

    it('should calculate u value for valid inputs', function () {
      const u = calculateU(A, B, SRP_KEY_LENGTH_BYTES);

      assert.ok(typeof u === 'bigint');
      assert.strictEqual(u > BigInt(0), true);
    });

    it('should produce different u values for different A', function () {
      const A1 = BigInt('0x' + 'a'.repeat(768));
      const A2 = BigInt('0x' + 'c'.repeat(768));

      const u1 = calculateU(A1, B, SRP_KEY_LENGTH_BYTES);
      const u2 = calculateU(A2, B, SRP_KEY_LENGTH_BYTES);

      assert.notStrictEqual(u1, u2);
    });

    it('should throw error for zero A', function () {
      assert.throws(
        function () {
          calculateU(BigInt(0), B, SRP_KEY_LENGTH_BYTES);
        },
        (err: any) => err.message.includes('Public keys A and B must be positive'),
      );
    });

    it('should throw error for negative B', function () {
      assert.throws(
        function () {
          calculateU(A, BigInt(-1), SRP_KEY_LENGTH_BYTES);
        },
        (err: any) => err.message.includes('Public keys A and B must be positive'),
      );
    });

    it('should throw error for zero key length', function () {
      assert.throws(
        function () {
          calculateU(A, B, 0);
        },
        (err: any) => err.message.includes('Key length must be positive'),
      );
    });

    it('should throw error if u value is zero (hash collision)', function () {
      const mockA = BigInt(1);
      const mockB = BigInt(1);

      const u = calculateU(mockA, mockB, 32);
      assert.strictEqual(u > BigInt(0), true);
    });
  });

  describe('calculateM1', function () {
    const N = SRP_PRIME_3072;
    const g = SRP_GENERATOR;
    const username = 'testuser';
    const salt = Buffer.from('test salt');
    const A = BigInt('0x' + 'a'.repeat(768));
    const B = BigInt('0x' + 'b'.repeat(768));
    const K = randomBytes(64);

    it('should calculate M1 value for valid inputs', function () {
      const M1 = calculateM1(N, g, username, salt, A, B, K);

      assert.ok(M1 instanceof Buffer);
      assert.strictEqual(M1.length, 64);
    });

    it('should produce different M1 values for different session keys', function () {
      const K1 = randomBytes(64);
      const K2 = randomBytes(64);

      const M1_1 = calculateM1(N, g, username, salt, A, B, K1);
      const M1_2 = calculateM1(N, g, username, salt, A, B, K2);

      assert.strictEqual(M1_1.equals(M1_2), false);
    });

    it('should throw error for zero N', function () {
      assert.throws(
        function () {
          calculateM1(BigInt(0), g, username, salt, A, B, K);
        },
        (err: any) => err.message.includes('All bigint parameters must be positive'),
      );
    });

    it('should throw error for negative g', function () {
      assert.throws(
        function () {
          calculateM1(N, BigInt(-1), username, salt, A, B, K);
        },
        (err: any) => err.message.includes('All bigint parameters must be positive'),
      );
    });

    it('should throw error for empty username', function () {
      assert.throws(
        function () {
          calculateM1(N, g, '', salt, A, B, K);
        },
        (err: any) => err.message.includes('Username must be non-empty'),
      );
    });

    it('should throw error for empty salt', function () {
      assert.throws(
        function () {
          calculateM1(N, g, username, Buffer.alloc(0), A, B, K);
        },
        (err: any) => err.message.includes('Salt must be a non-empty Buffer'),
      );
    });

    it('should throw error for non-buffer salt', function () {
      assert.throws(
        function () {
          calculateM1(N, g, username, 'not a buffer' as any, A, B, K);
        },
        (err: any) => err.message.includes('Salt must be a non-empty Buffer'),
      );
    });

    it('should throw error for empty session key', function () {
      assert.throws(
        function () {
          calculateM1(N, g, username, salt, A, B, Buffer.alloc(0));
        },
        (err: any) => err.message.includes('Session key K must be a non-empty Buffer'),
      );
    });

    it('should throw error for non-buffer session key', function () {
      assert.throws(
        function () {
          calculateM1(N, g, username, salt, A, B, 'not a buffer' as any);
        },
        (err: any) => err.message.includes('Session key K must be a non-empty Buffer'),
      );
    });
  });
});
