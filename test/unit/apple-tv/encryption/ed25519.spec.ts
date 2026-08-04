import assert from 'node:assert/strict';
import {beforeEach, describe, it} from 'node:test';

import {createEd25519Signature, generateEd25519KeyPair} from '../../../../src/lib/apple-tv/encryption/ed25519.js';
import {CryptographyError} from '../../../../src/lib/apple-tv/errors.js';

describe('Apple TV Encryption - Ed25519', function () {
  describe('generateEd25519KeyPair', function () {
    it('should generate a valid key pair', function () {
      const keyPair = generateEd25519KeyPair();

      assert.ok('publicKey' in keyPair);
      assert.ok('privateKey' in keyPair);
      assert.ok(keyPair.publicKey instanceof Buffer);
      assert.ok(keyPair.privateKey instanceof Buffer);
      assert.strictEqual(keyPair.publicKey.length, 32);
      assert.strictEqual(keyPair.privateKey.length, 32);
    });

    it('should generate different key pairs each time', function () {
      const keyPair1 = generateEd25519KeyPair();
      const keyPair2 = generateEd25519KeyPair();

      assert.strictEqual(keyPair1.publicKey.equals(keyPair2.publicKey), false);
      assert.strictEqual(keyPair1.privateKey.equals(keyPair2.privateKey), false);
    });
  });

  describe('createEd25519Signature', function () {
    let validPrivateKey: Buffer;

    beforeEach(function () {
      const keyPair = generateEd25519KeyPair();
      validPrivateKey = keyPair.privateKey;
    });

    it('should create a valid signature', function () {
      const data = Buffer.from('Hello, World!', 'utf8');
      const signature = createEd25519Signature(data, validPrivateKey);

      assert.ok(signature instanceof Buffer);
      assert.strictEqual(signature.length, 64);
    });

    it('should create consistent signatures for same data and key', function () {
      const data = Buffer.from('Test message', 'utf8');

      const signature1 = createEd25519Signature(data, validPrivateKey);
      const signature2 = createEd25519Signature(data, validPrivateKey);

      assert.strictEqual(signature1.equals(signature2), true);
    });

    it('should create different signatures for different data', function () {
      const data1 = Buffer.from('Message 1', 'utf8');
      const data2 = Buffer.from('Message 2', 'utf8');

      const signature1 = createEd25519Signature(data1, validPrivateKey);
      const signature2 = createEd25519Signature(data2, validPrivateKey);

      assert.strictEqual(signature1.equals(signature2), false);
    });

    it('should throw when data is empty', function () {
      const emptyData = Buffer.alloc(0);

      assert.throws(
        () => createEd25519Signature(emptyData, validPrivateKey),
        (err: any) => err instanceof CryptographyError && err.message.includes('Data to sign cannot be empty'),
      );
    });

    it('should throw when private key is wrong size', function () {
      const data = Buffer.from('test', 'utf8');
      const shortKey = Buffer.alloc(16);

      assert.throws(
        () => createEd25519Signature(data, shortKey),
        (err: any) => err instanceof CryptographyError && err.message.includes('Private key must be 32 bytes'),
      );
    });
  });
});
