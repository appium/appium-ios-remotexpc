import { logger } from '@appium/support';
import {
  type KeyPairKeyObjectResult,
  generateKeyPairSync,
  sign,
} from 'node:crypto';

import { CryptographyError } from '../errors.js';
import type { PairingKeys } from '../types.js';

const log = logger.getLogger('Ed25519');

const ED25519_PUBLIC_KEY_LENGTH = 32;
const ED25519_PRIVATE_KEY_LENGTH = 32;
const ED25519_PKCS8_PREFIX = Buffer.from(
  '302e020100300506032b657004220420',
  'hex',
);

/**
 * Generates a new Ed25519 key pair for cryptographic operations
 * @returns PairingKeys object containing 32-byte public and private key buffers
 * @throws CryptographyError if key generation fails
 */
export function generateEd25519KeyPair(): PairingKeys {
  try {
    const keyPair: KeyPairKeyObjectResult = generateKeyPairSync('ed25519');

    const publicKeyDer = keyPair.publicKey.export({
      type: 'spki',
      format: 'der',
    }) as Buffer;

    const privateKeyDer = keyPair.privateKey.export({
      type: 'pkcs8',
      format: 'der',
    }) as Buffer;

    const publicKeyBuffer = extractEd25519PublicKey(publicKeyDer);
    const privateKeyBuffer = extractEd25519PrivateKey(privateKeyDer);

    return {
      publicKey: publicKeyBuffer,
      privateKey: privateKeyBuffer,
    };
  } catch (error) {
    log.error('Failed to generate Ed25519 key pair:', error);
    const message = error instanceof Error ? error.message : String(error);
    throw new CryptographyError(
      `Failed to generate Ed25519 key pair: ${message}`,
    );
  }
}

/**
 * Creates an Ed25519 digital signature for the provided data
 * @param data - The data to sign
 * @param privateKey - 32-byte Ed25519 private key
 * @returns Buffer containing the 64-byte signature
 * @throws CryptographyError if signing fails or private key is invalid
 */
export function createEd25519Signature(
  data: Buffer,
  privateKey: Buffer,
): Buffer {
  if (!data || data.length === 0) {
    throw new CryptographyError('Data to sign cannot be empty');
  }

  if (!privateKey || privateKey.length !== ED25519_PRIVATE_KEY_LENGTH) {
    throw new CryptographyError(
      `Private key must be ${ED25519_PRIVATE_KEY_LENGTH} bytes`,
    );
  }

  try {
    const privateKeyDer = Buffer.concat([ED25519_PKCS8_PREFIX, privateKey]);

    return sign(null, data, {
      key: privateKeyDer,
      format: 'der',
      type: 'pkcs8',
    });
  } catch (error) {
    log.error('Failed to create Ed25519 signature:', error);
    const message = error instanceof Error ? error.message : String(error);
    throw new CryptographyError(
      `Failed to create Ed25519 signature: ${message}`,
    );
  }
}

/**
 * Extracts the raw 32-byte public key from DER-encoded SPKI format
 * @param publicKeyDer - DER-encoded public key
 * @returns 32-byte public key buffer
 * @throws CryptographyError if extraction fails
 */
function extractEd25519PublicKey(publicKeyDer: Buffer): Buffer {
  if (publicKeyDer.length < ED25519_PUBLIC_KEY_LENGTH) {
    throw new CryptographyError('Invalid public key DER format');
  }

  return publicKeyDer.subarray(publicKeyDer.length - ED25519_PUBLIC_KEY_LENGTH);
}

/**
 * Extracts the raw 32-byte private key from DER-encoded PKCS#8 format
 * @param privateKeyDer - DER-encoded private key
 * @returns 32-byte private key buffer
 * @throws CryptographyError if extraction fails
 */
function extractEd25519PrivateKey(privateKeyDer: Buffer): Buffer {
  const octetStringPattern = Buffer.from([0x04, 0x20]);
  const index = privateKeyDer.indexOf(octetStringPattern);

  if (index !== -1 && index + 34 <= privateKeyDer.length) {
    return privateKeyDer.subarray(index + 2, index + 34);
  }

  if (privateKeyDer.length >= 48) {
    return privateKeyDer.subarray(16, 48);
  }

  throw new CryptographyError('Unable to extract private key from DER format');
}
