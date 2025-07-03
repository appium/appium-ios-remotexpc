import { createCipheriv, createDecipheriv } from 'node:crypto';

import { CryptographyError } from '../errors.js';

export interface ChaCha20Poly1305Params {
  plaintext?: Buffer;
  ciphertext?: Buffer;
  key: Buffer;
  nonce: Buffer;
  aad?: Buffer;
}

interface DecryptionAttempt {
  tagLen: number;
  aad?: Buffer;
}

/**
 * Encrypts data using ChaCha20-Poly1305 AEAD cipher
 * @param params - Encryption parameters including plaintext, key, nonce, and optional AAD
 * @returns Buffer containing encrypted data concatenated with authentication tag
 * @throws CryptographyError if encryption fails or required parameters are missing
 */
export function encryptChaCha20Poly1305(
  params: ChaCha20Poly1305Params,
): Buffer {
  const { plaintext, key, nonce, aad } = params;

  if (!plaintext) {
    throw new CryptographyError('Plaintext is required for encryption');
  }

  if (!key || key.length !== 32) {
    throw new CryptographyError('Key must be 32 bytes');
  }

  if (!nonce || nonce.length !== 12) {
    throw new CryptographyError('Nonce must be 12 bytes');
  }

  try {
    const cipher = createCipheriv('chacha20-poly1305', key, nonce) as any;

    if (aad) {
      cipher.setAAD(aad, { plaintextLength: plaintext.length });
    }

    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return Buffer.concat([encrypted, authTag]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CryptographyError(
      `ChaCha20-Poly1305 encryption failed: ${message}`,
    );
  }
}

/**
 * Decrypts data using ChaCha20-Poly1305 AEAD cipher with multiple fallback strategies
 * @param params - Decryption parameters including ciphertext, key, nonce, and optional AAD
 * @returns Buffer containing decrypted plaintext
 * @throws CryptographyError if all decryption attempts fail or required parameters are missing
 */
export function decryptChaCha20Poly1305(
  params: ChaCha20Poly1305Params,
): Buffer {
  const { ciphertext, key, nonce, aad } = params;

  if (!ciphertext) {
    throw new CryptographyError('Ciphertext is required for decryption');
  }

  if (!key || key.length !== 32) {
    throw new CryptographyError('Key must be 32 bytes');
  }

  if (!nonce || nonce.length !== 12) {
    throw new CryptographyError('Nonce must be 12 bytes');
  }

  if (ciphertext.length < 16) {
    throw new CryptographyError(
      'Ciphertext too short to contain authentication tag',
    );
  }

  const decryptionAttempts: DecryptionAttempt[] = [
    { tagLen: 16, aad },
    { tagLen: 16, aad: Buffer.alloc(0) },
    { tagLen: 16, aad: undefined },
    { tagLen: 12, aad },
    { tagLen: 12, aad: Buffer.alloc(0) },
  ];

  for (const attempt of decryptionAttempts) {
    try {
      const encrypted = ciphertext.subarray(
        0,
        ciphertext.length - attempt.tagLen,
      );
      const authTag = ciphertext.subarray(ciphertext.length - attempt.tagLen);

      const decipher = createDecipheriv('chacha20-poly1305', key, nonce) as any;
      decipher.setAuthTag(authTag);

      if (attempt.aad !== undefined) {
        decipher.setAAD(attempt.aad, { plaintextLength: encrypted.length });
      }

      return Buffer.concat([decipher.update(encrypted), decipher.final()]);
    } catch {
      // Continue to next decryption attempt
    }
  }

  throw new CryptographyError(
    'ChaCha20-Poly1305 decryption failed: invalid ciphertext or authentication tag',
  );
}
