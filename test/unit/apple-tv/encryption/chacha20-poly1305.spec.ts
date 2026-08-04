import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {
  type ChaCha20Poly1305Params,
  decryptChaCha20Poly1305,
  encryptChaCha20Poly1305,
} from '../../../../src/lib/apple-tv/encryption/chacha20-poly1305.js';
import {CryptographyError} from '../../../../src/lib/apple-tv/errors.js';

describe('Apple TV Encryption - ChaCha20-Poly1305', function () {
  const validKey = Buffer.alloc(32, 0x42);
  const validNonce = Buffer.alloc(12, 0x24);
  const plaintext = Buffer.from('Hello, World!', 'utf8');
  const aad = Buffer.from('additional authenticated data', 'utf8');

  const appleTVNonce = Buffer.concat([Buffer.alloc(4), Buffer.from('PS-Msg06')]);

  describe('encryptChaCha20Poly1305', function () {
    it('should encrypt plaintext without AAD', function () {
      const params: ChaCha20Poly1305Params = {
        plaintext,
        key: validKey,
        nonce: validNonce,
      };

      const result = encryptChaCha20Poly1305(params);

      assert.ok(result instanceof Buffer);
      assert.strictEqual(result.length, plaintext.length + 16);
    });

    it('should encrypt plaintext with AAD', function () {
      const params: ChaCha20Poly1305Params = {
        plaintext,
        key: validKey,
        nonce: validNonce,
        aad,
      };

      const result = encryptChaCha20Poly1305(params);

      assert.ok(result instanceof Buffer);
      assert.strictEqual(result.length, plaintext.length + 16);
    });

    it('should throw when plaintext is missing', function () {
      const params: ChaCha20Poly1305Params = {
        key: validKey,
        nonce: validNonce,
      };

      assert.throws(
        () => encryptChaCha20Poly1305(params),
        (err: any) => err instanceof CryptographyError && err.message.includes('Plaintext is required for encryption'),
      );
    });

    it('should throw when key is wrong size', function () {
      const params: ChaCha20Poly1305Params = {
        plaintext,
        key: Buffer.alloc(16),
        nonce: validNonce,
      };

      assert.throws(
        () => encryptChaCha20Poly1305(params),
        (err: any) => err instanceof CryptographyError && err.message.includes('Key must be 32 bytes'),
      );
    });

    it('should throw when nonce is wrong size', function () {
      const params: ChaCha20Poly1305Params = {
        plaintext,
        key: validKey,
        nonce: Buffer.alloc(8),
      };

      assert.throws(
        () => encryptChaCha20Poly1305(params),
        (err: any) => err instanceof CryptographyError && err.message.includes('Nonce must be 12 bytes'),
      );
    });
  });

  describe('decryptChaCha20Poly1305', function () {
    it('should decrypt ciphertext without AAD', function () {
      const encrypted = encryptChaCha20Poly1305({
        plaintext,
        key: validKey,
        nonce: validNonce,
      });

      const decrypted = decryptChaCha20Poly1305({
        ciphertext: encrypted,
        key: validKey,
        nonce: validNonce,
      });

      assert.ok(decrypted instanceof Buffer);
      assert.strictEqual(decrypted.equals(plaintext), true);
    });

    it('should decrypt ciphertext with AAD', function () {
      const encrypted = encryptChaCha20Poly1305({
        plaintext,
        key: validKey,
        nonce: validNonce,
        aad,
      });

      const decrypted = decryptChaCha20Poly1305({
        ciphertext: encrypted,
        key: validKey,
        nonce: validNonce,
        aad,
      });

      assert.strictEqual(decrypted.equals(plaintext), true);
    });

    it('should fail to decrypt with wrong key', function () {
      const encrypted = encryptChaCha20Poly1305({
        plaintext,
        key: validKey,
        nonce: validNonce,
      });

      const wrongKey = Buffer.alloc(32, 0x99);

      assert.throws(
        () =>
          decryptChaCha20Poly1305({
            ciphertext: encrypted,
            key: wrongKey,
            nonce: validNonce,
          }),
        (err: any) => err instanceof CryptographyError && err.message.includes('ChaCha20-Poly1305 decryption failed'),
      );
    });

    it('should throw when ciphertext is too short', function () {
      const params: ChaCha20Poly1305Params = {
        ciphertext: Buffer.alloc(10),
        key: validKey,
        nonce: validNonce,
      };

      assert.throws(
        () => decryptChaCha20Poly1305(params),
        (err: any) =>
          err instanceof CryptographyError &&
          err.message.includes('Ciphertext too short to contain authentication tag'),
      );
    });

    it('should handle Apple TV pairing nonce pattern', function () {
      const encrypted = encryptChaCha20Poly1305({
        plaintext,
        key: validKey,
        nonce: appleTVNonce,
      });

      const decrypted = decryptChaCha20Poly1305({
        ciphertext: encrypted,
        key: validKey,
        nonce: appleTVNonce,
      });

      assert.strictEqual(decrypted.equals(plaintext), true);
    });

    it('should decrypt large ciphertext like Apple TV M6 message', function () {
      const largePlaintext = Buffer.alloc(412, 0x01);

      const encrypted = encryptChaCha20Poly1305({
        plaintext: largePlaintext,
        key: validKey,
        nonce: appleTVNonce,
      });

      assert.strictEqual(encrypted.length, 428);

      const decrypted = decryptChaCha20Poly1305({
        ciphertext: encrypted,
        key: validKey,
        nonce: appleTVNonce,
      });

      assert.strictEqual(decrypted.equals(largePlaintext), true);
    });

    it('should handle decryption with empty AAD when encrypted without AAD', function () {
      const encrypted = encryptChaCha20Poly1305({
        plaintext,
        key: validKey,
        nonce: validNonce,
      });

      const decrypted = decryptChaCha20Poly1305({
        ciphertext: encrypted,
        key: validKey,
        nonce: validNonce,
        aad: Buffer.alloc(0),
      });

      assert.strictEqual(decrypted.equals(plaintext), true);
    });

    it('should fail to decrypt when AAD is missing but was used in encryption', function () {
      const encrypted = encryptChaCha20Poly1305({
        plaintext,
        key: validKey,
        nonce: validNonce,
        aad,
      });

      assert.throws(
        () =>
          decryptChaCha20Poly1305({
            ciphertext: encrypted,
            key: validKey,
            nonce: validNonce,
          }),
        (err: any) => err instanceof CryptographyError && err.message.includes('ChaCha20-Poly1305 decryption failed'),
      );
    });

    it('should handle shared key scenario for encryption and decryption', function () {
      const sharedKey = Buffer.from('79f81b432d16662d43bfe8f5af4ae27b79f81b432d16662d43bfe8f5af4ae27b', 'hex');

      const encrypted = encryptChaCha20Poly1305({
        plaintext,
        key: sharedKey,
        nonce: appleTVNonce,
      });

      const decrypted = decryptChaCha20Poly1305({
        ciphertext: encrypted,
        key: sharedKey,
        nonce: appleTVNonce,
      });

      assert.strictEqual(decrypted.equals(plaintext), true);
    });
  });
});
