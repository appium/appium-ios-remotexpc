import {randomUUID} from 'node:crypto';

import type {IXPCUUID} from '../types.js';

const UUID_BYTE_LENGTH = 16;
const UUID_HEX_PATTERN = /^[0-9a-f]{32}$/;

/**
 * A UUID value in the XPC protocol (`XPC_TYPE_UUID`).
 *
 * The encoder writes plain `Buffer`s as `XPC_TYPE_DATA`; wrapping the bytes in
 * this class is what selects the UUID type instead. Services that expect a UUID
 * (for example `com.apple.coredevice.displayservice`, whose
 * `avcMediaStreamOptionClientSessionID` option is a UUID) reject a `data` value
 * in its place.
 *
 * @example
 * ```ts
 * const sessionId = XPCUUID.random();
 * await service.invoke(feature, {options: {sessionID: {uuid: sessionId}}});
 * ```
 */
export class XPCUUID implements IXPCUUID {
  readonly uuidBytes: Buffer;

  /**
   * @param value 16 raw bytes, or a UUID string (dashed or bare hex, any case).
   */
  constructor(value: Buffer | Uint8Array | string) {
    this.uuidBytes = typeof value === 'string' ? parseUuidString(value) : copyUuidBytes(value);
  }

  /** Creates a fresh random (version 4) UUID. */
  static random(): XPCUUID {
    return new XPCUUID(randomUUID());
  }

  /**
   * Coerces a decoded XPC value into an {@link XPCUUID}, or `undefined` when it
   * is not UUID-shaped. The decoder surfaces `XPC_TYPE_UUID` as a bare 32-char
   * hex string, so replies must be re-parsed before being echoed back.
   */
  static asOptionalUuid(value: unknown): XPCUUID | undefined {
    if (value instanceof XPCUUID) {
      return value;
    }
    if (typeof value === 'string') {
      try {
        return new XPCUUID(value);
      } catch {
        return undefined;
      }
    }
    if (Buffer.isBuffer(value) && value.length === UUID_BYTE_LENGTH) {
      return new XPCUUID(value);
    }
    return undefined;
  }

  /** The canonical dashed, lower-case representation (`8-4-4-4-12`). */
  toString(): string {
    const hex = this.uuidBytes.toString('hex');
    return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32)].join('-');
  }

  toJSON(): string {
    return this.toString();
  }
}

function copyUuidBytes(value: Buffer | Uint8Array): Buffer {
  if (value.length !== UUID_BYTE_LENGTH) {
    throw new TypeError(`XPC UUID must be ${UUID_BYTE_LENGTH} bytes, got ${value.length}`);
  }
  return Buffer.from(value);
}

function parseUuidString(value: string): Buffer {
  const hex = value.replace(/-/g, '').toLowerCase();
  if (!UUID_HEX_PATTERN.test(hex)) {
    throw new TypeError(`Invalid UUID string: '${value}'`);
  }
  return Buffer.from(hex, 'hex');
}

export default XPCUUID;
