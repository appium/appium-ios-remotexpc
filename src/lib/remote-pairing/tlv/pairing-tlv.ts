import { PairingDataComponentType } from '../constants.js';
import { encodeTLV8 } from './encoder.js';

/**
 * Creates TLV8-encoded setup data for manual pairing, with default METHOD and STATE.
 *
 * @returns Base64-encoded TLV8 string for manual pairing
 */
export function createSetupManualPairingData(): string {
  const tlv = encodeTLV8([
    { type: PairingDataComponentType.METHOD, data: Buffer.from([0x00]) },
    { type: PairingDataComponentType.STATE, data: Buffer.from([0x01]) },
  ]);

  return tlv.toString('base64');
}

/**
 * Creates TLV8-encoded data for pair verification, including the X25519 public key.
 *
 * @param x25519PublicKey - A buffer containing the X25519 public key
 * @returns Base64-encoded TLV8 string for verification
 */
export function createPairVerificationData(x25519PublicKey: Buffer): string {
  const tlv = encodeTLV8([
    { type: PairingDataComponentType.STATE, data: Buffer.from([0x01]) },
    { type: PairingDataComponentType.PUBLIC_KEY, data: x25519PublicKey },
  ]);

  return tlv.toString('base64');
}
