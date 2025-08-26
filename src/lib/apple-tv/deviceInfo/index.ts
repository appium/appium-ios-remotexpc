import { hostname } from 'node:os';

import { Opack2 } from '../encryption/index.js';
import type { AppleTVDeviceInfo } from '../types.js';

type OpackSerialized = Buffer;

const DEFAULT_ALT_IRK = Buffer.from([
  0xe9, 0xe8, 0x2d, 0xc0, 0x6a, 0x49, 0x79, 0x6b, 0x56, 0x6f, 0x54, 0x00, 0x19,
  0xb1, 0xc7, 0x7b,
]);
const DEFAULT_BT_ADDR = '11:22:33:44:55:66';
const DEFAULT_MAC_BUFFER = Buffer.from([0x11, 0x22, 0x33, 0x44, 0x55, 0x66]);
const DEFAULT_PAIRING_SERIAL = 'AAAAAAAAAAAA';

/**
 * Creates a standardized Apple TV device information object with default values
 * and the specified identifier as the account ID.
 *
 * @param identifier - Unique identifier to use as the account ID
 * @returns Complete Apple TV device information object
 */
export function createAppleTVDeviceInfo(identifier: string): AppleTVDeviceInfo {
  return {
    altIRK: DEFAULT_ALT_IRK,
    btAddr: DEFAULT_BT_ADDR,
    mac: DEFAULT_MAC_BUFFER,
    remotePairingSerialNumber: DEFAULT_PAIRING_SERIAL,
    accountID: identifier,
    model: 'computer-model',
    name: hostname(),
  };
}

/**
 * Encodes Apple TV device information into a binary buffer using Opack2 serialization.
 * This creates the device info object and immediately serializes it for transmission.
 *
 * @param identifier - Unique identifier to use as the account ID
 * @returns Serialized device information as a Buffer
 */
export function encodeAppleTVDeviceInfo(identifier: string): OpackSerialized {
  const deviceInfo = createAppleTVDeviceInfo(identifier);

  // Cast to SerializableValue to ensure type compatibility with Opack2.dumps
  // The AppleTVDeviceInfo structure is compatible with OPACK2 serialization
  return Opack2.dumps(deviceInfo as Record<string, any>);
}
