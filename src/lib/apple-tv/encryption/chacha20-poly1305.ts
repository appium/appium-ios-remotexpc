import { logger } from '@appium/support';
import { createCipheriv, createDecipheriv } from 'node:crypto';

import { CryptographyError } from '../errors.js';

const log = logger.getLogger('ChaCha20Poly1305');

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
    log.error('ChaCha20-Poly1305 encryption failed:', error);
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

  // ChaCha20-Poly1305 in Node.js only supports 16-byte authentication tags
  const tagLength = 16;
  const decryptionAttempts: DecryptionAttempt[] = [
    { tagLen: tagLength, aad },
    { tagLen: tagLength, aad: Buffer.alloc(0) },
    { tagLen: tagLength, aad: undefined },
  ];

  let lastError: Error | undefined;

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

      const decrypted = Buffer.concat([
        decipher.update(encrypted),
        decipher.final(),
      ]);

      log.debug(
        'Decryption successful with AAD:',
        attempt.aad ? 'provided' : 'none',
      );
      return decrypted;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  const errorMessage = lastError
    ? `ChaCha20-Poly1305 decryption failed: ${lastError.message}`
    : 'ChaCha20-Poly1305 decryption failed: invalid ciphertext or authentication tag';

  // Log the error with stack trace for debugging real failures
  // Skip logging in test environment to avoid cluttering test output with expected failures
  if (lastError && process.env.NODE_ENV !== 'test') {
    log.error('All ChaCha20-Poly1305 decryption attempts failed:', {
      message: lastError.message,
      stack: lastError.stack,
    });
  }

  throw new CryptographyError(errorMessage);
}
