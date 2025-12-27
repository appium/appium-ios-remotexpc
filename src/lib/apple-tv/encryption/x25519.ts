import {
  type KeyObject,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
} from 'node:crypto';

import { getLogger } from '../../logger.js';
import { CryptographyError } from '../errors.js';

const log = getLogger('X25519');

const X25519_PUBLIC_KEY_LENGTH = 32;
const X25519_SPKI_PREFIX = Buffer.from([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x03, 0x21, 0x00,
]);

export interface X25519KeyPair {
  publicKey: Buffer;
  privateKey: KeyObject;
}

export function generateX25519KeyPair(): X25519KeyPair {
  try {
    const { publicKey, privateKey } = generateKeyPairSync('x25519');

    const publicKeyDer = publicKey.export({
      type: 'spki',
      format: 'der',
    }) as Buffer;
    const publicKeyBytes = publicKeyDer.subarray(-X25519_PUBLIC_KEY_LENGTH);

    return {
      publicKey: publicKeyBytes,
      privateKey,
    };
  } catch (error) {
    log.error('Failed to generate X25519 key pair:', error);
    const message = error instanceof Error ? error.message : String(error);
    throw new CryptographyError(
      `Failed to generate X25519 key pair: ${message}`,
    );
  }
}

export function performX25519DiffieHellman(
  privateKey: KeyObject,
  devicePublicKey: Buffer,
): Buffer {
  if (!devicePublicKey || devicePublicKey.length !== X25519_PUBLIC_KEY_LENGTH) {
    throw new CryptographyError(
      `Device public key must be ${X25519_PUBLIC_KEY_LENGTH} bytes`,
    );
  }

  try {
    const devicePublicKeySpki = Buffer.concat([
      X25519_SPKI_PREFIX,
      devicePublicKey,
    ]);

    const publicKeyObject = createPublicKey({
      key: devicePublicKeySpki,
      format: 'der',
      type: 'spki',
    });

    return diffieHellman({
      privateKey,
      publicKey: publicKeyObject,
    });
  } catch (error) {
    log.error('Failed to perform X25519 Diffie-Hellman:', error);
    const message = error instanceof Error ? error.message : String(error);
    throw new CryptographyError(
      `Failed to perform X25519 Diffie-Hellman: ${message}`,
    );
  }
}
