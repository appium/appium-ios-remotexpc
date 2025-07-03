import { expect } from 'chai';
import { describe, it } from 'mocha';

import {
  type ChaCha20Poly1305Params,
  decryptChaCha20Poly1305,
  encryptChaCha20Poly1305,
} from '../../../../src/lib/apple-tv/encryption/chacha20-poly1305.js';
import { CryptographyError } from '../../../../src/lib/apple-tv/errors.js';

describe('Apple TV Encryption - ChaCha20-Poly1305', () => {
  const validKey = Buffer.alloc(32, 0x42);
  const validNonce = Buffer.alloc(12, 0x24);
  const plaintext = Buffer.from('Hello, World!', 'utf8');
  const aad = Buffer.from('additional authenticated data', 'utf8');

  const appleTVNonce = Buffer.concat([
    Buffer.alloc(4),
    Buffer.from('PS-Msg06'),
  ]);

  describe('encryptChaCha20Poly1305', () => {
    it('should encrypt plaintext without AAD', () => {
      const params: ChaCha20Poly1305Params = {
        plaintext,
        key: validKey,
        nonce: validNonce,
      };

      const result = encryptChaCha20Poly1305(params);

      expect(result).to.be.instanceOf(Buffer);
      expect(result.length).to.equal(plaintext.length + 16);
    });

    it('should encrypt plaintext with AAD', () => {
      const params: ChaCha20Poly1305Params = {
        plaintext,
        key: validKey,
        nonce: validNonce,
        aad,
      };

      const result = encryptChaCha20Poly1305(params);

      expect(result).to.be.instanceOf(Buffer);
      expect(result.length).to.equal(plaintext.length + 16);
    });

    it('should throw when plaintext is missing', () => {
      const params: ChaCha20Poly1305Params = {
        key: validKey,
        nonce: validNonce,
      };

      expect(() => encryptChaCha20Poly1305(params)).to.throw(
        CryptographyError,
        'Plaintext is required for encryption',
      );
    });

    it('should throw when key is wrong size', () => {
      const params: ChaCha20Poly1305Params = {
        plaintext,
        key: Buffer.alloc(16),
        nonce: validNonce,
      };

      expect(() => encryptChaCha20Poly1305(params)).to.throw(
        CryptographyError,
        'Key must be 32 bytes',
      );
    });

    it('should throw when nonce is wrong size', () => {
      const params: ChaCha20Poly1305Params = {
        plaintext,
        key: validKey,
        nonce: Buffer.alloc(8),
      };

      expect(() => encryptChaCha20Poly1305(params)).to.throw(
        CryptographyError,
        'Nonce must be 12 bytes',
      );
    });
  });

  describe('decryptChaCha20Poly1305', () => {
    it('should decrypt ciphertext without AAD', () => {
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

      expect(decrypted).to.be.instanceOf(Buffer);
      expect(decrypted.equals(plaintext)).to.be.true;
    });

    it('should decrypt ciphertext with AAD', () => {
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

      expect(decrypted.equals(plaintext)).to.be.true;
    });

    it('should fail to decrypt with wrong key', () => {
      const encrypted = encryptChaCha20Poly1305({
        plaintext,
        key: validKey,
        nonce: validNonce,
      });

      const wrongKey = Buffer.alloc(32, 0x99);

      expect(() =>
        decryptChaCha20Poly1305({
          ciphertext: encrypted,
          key: wrongKey,
          nonce: validNonce,
        }),
      ).to.throw(CryptographyError, 'ChaCha20-Poly1305 decryption failed');
    });

    it('should throw when ciphertext is too short', () => {
      const params: ChaCha20Poly1305Params = {
        ciphertext: Buffer.alloc(10),
        key: validKey,
        nonce: validNonce,
      };

      expect(() => decryptChaCha20Poly1305(params)).to.throw(
        CryptographyError,
        'Ciphertext too short to contain authentication tag',
      );
    });

    it('should handle Apple TV pairing nonce pattern', () => {
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

      expect(decrypted.equals(plaintext)).to.be.true;
    });

    it('should decrypt large ciphertext like Apple TV M6 message', () => {
      const largePlaintext = Buffer.alloc(412, 0x01);

      const encrypted = encryptChaCha20Poly1305({
        plaintext: largePlaintext,
        key: validKey,
        nonce: appleTVNonce,
      });

      expect(encrypted.length).to.equal(428);

      const decrypted = decryptChaCha20Poly1305({
        ciphertext: encrypted,
        key: validKey,
        nonce: appleTVNonce,
      });

      expect(decrypted.equals(largePlaintext)).to.be.true;
    });

    it('should handle decryption with empty AAD when encrypted without AAD', () => {
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

      expect(decrypted.equals(plaintext)).to.be.true;
    });

    it('should fail to decrypt when AAD is missing but was used in encryption', () => {
      const encrypted = encryptChaCha20Poly1305({
        plaintext,
        key: validKey,
        nonce: validNonce,
        aad,
      });

      expect(() =>
        decryptChaCha20Poly1305({
          ciphertext: encrypted,
          key: validKey,
          nonce: validNonce,
        }),
      ).to.throw(CryptographyError, 'ChaCha20-Poly1305 decryption failed');
    });

    it('should handle shared key scenario for encryption and decryption', () => {
      const sharedKey = Buffer.from(
        '79f81b432d16662d43bfe8f5af4ae27b79f81b432d16662d43bfe8f5af4ae27b',
        'hex',
      );

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

      expect(decrypted.equals(plaintext)).to.be.true;
    });
  });
});
