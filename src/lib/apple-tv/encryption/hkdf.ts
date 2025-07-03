import { logger } from '@appium/support';
import { createHmac } from 'node:crypto';

import { HKDF_HASH_ALGORITHM, HKDF_HASH_LENGTH } from '../constants.js';
import { CryptographyError } from '../errors.js';

const log = logger.getLogger('HKDF');

export interface HKDFParams {
  ikm: Buffer;
  salt: Buffer | null;
  info: Buffer;
  length: number;
}

const MAX_OUTPUT_LENGTH = 255 * HKDF_HASH_LENGTH;

/**
 * HMAC-based Key Derivation Function (HKDF) as defined in RFC 5869
 * Derives cryptographic keys from input key material using a two-step process:
 * 1. Extract: Generate a pseudorandom key from the input key material
 * 2. Expand: Expand the pseudorandom key to the desired output length
 *
 * @param params - HKDF parameters including input key material, salt, info, and desired output length
 * @returns Buffer containing the derived key material of specified length
 * @throws CryptographyError if derivation fails or parameters are invalid
 */
export function hkdf(params: HKDFParams): Buffer {
  const { ikm, salt, info, length } = params;

  if (!ikm || ikm.length === 0) {
    throw new CryptographyError('Input key material (IKM) cannot be empty');
  }

  if (!info) {
    throw new CryptographyError('Info parameter is required');
  }

  if (length <= 0) {
    throw new CryptographyError('Output length must be positive');
  }

  if (length > MAX_OUTPUT_LENGTH) {
    throw new CryptographyError(
      `Output length cannot exceed ${MAX_OUTPUT_LENGTH} bytes`,
    );
  }

  try {
    const extractedKey = hkdfExtract(ikm, salt);
    return hkdfExpand(extractedKey, info, length);
  } catch (error) {
    log.error('HKDF derivation failed:', error);
    const message = error instanceof Error ? error.message : String(error);
    throw new CryptographyError(`HKDF derivation failed: ${message}`);
  }
}

/**
 * HKDF Extract step: generates a pseudorandom key from input key material
 * @param ikm - Input key material
 * @param salt - Optional salt value (uses zero salt if null)
 * @returns Pseudorandom key of hash length
 */
function hkdfExtract(ikm: Buffer, salt: Buffer | null): Buffer {
  const actualSalt = salt || Buffer.alloc(HKDF_HASH_LENGTH);
  return createHmac(HKDF_HASH_ALGORITHM, actualSalt).update(ikm).digest();
}

/**
 * HKDF Expand a step: expands a pseudorandom key to desired output length
 * @param prk - Pseudorandom key from extract step
 * @param info - Context and application specific information
 * @param length - Desired output key material length
 * @returns Output key material of specified length
 */
function hkdfExpand(prk: Buffer, info: Buffer, length: number): Buffer {
  const numberOfBlocks = Math.ceil(length / HKDF_HASH_LENGTH);
  const blocks: Buffer[] = [];
  let previousBlock: Buffer = Buffer.alloc(0);

  for (let blockIndex = 1; blockIndex <= numberOfBlocks; blockIndex++) {
    const hmac = createHmac(HKDF_HASH_ALGORITHM, prk);
    hmac.update(previousBlock);
    hmac.update(info);
    hmac.update(Buffer.from([blockIndex]));

    const currentBlock = hmac.digest();
    blocks.push(currentBlock);
    previousBlock = currentBlock;
  }

  const outputKeyMaterial = Buffer.concat(blocks);
  return outputKeyMaterial.subarray(0, length);
}
