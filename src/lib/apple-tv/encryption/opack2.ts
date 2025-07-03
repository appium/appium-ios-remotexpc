import {
  OPACK2_FALSE,
  OPACK2_NULL,
  OPACK2_SMALL_ARRAY_MAX,
  OPACK2_SMALL_BYTES_MAX,
  OPACK2_SMALL_DICT_MAX,
  OPACK2_SMALL_INT_MAX,
  OPACK2_SMALL_INT_OFFSET,
  OPACK2_SMALL_STRING_MAX,
  OPACK2_TRUE,
} from '../constants.js';
import { AppleTVError } from '../errors.js';

interface SerializableArray extends Array<SerializableValue> {}
interface SerializableObject extends Record<string, SerializableValue> {}

type SerializableValue =
  | null
  | undefined
  | boolean
  | number
  | string
  | Buffer
  | SerializableArray
  | SerializableObject;

/**
 * OPACK2 binary serialization format encoder
 * Implements Apple's OPACK2 protocol for efficient binary serialization of structured data
 */
export class Opack2 {
  /**
   * Serializes a JavaScript object to OPACK2 binary format
   * @param obj - The object to serialize (supports primitives, arrays, objects, and Buffers)
   * @returns Buffer containing the serialized data
   * @throws AppleTVError if the object contains unsupported types
   */
  static dumps(obj: SerializableValue): Buffer {
    return this.encode(obj);
  }

  /**
   * Main encoding dispatcher that routes values to appropriate type-specific encoders
   * @param obj - Value to encode
   * @returns Buffer containing encoded value
   * @throws AppleTVError for unsupported types
   */
  private static encode(obj: SerializableValue): Buffer {
    if (obj === null || obj === undefined) {
      return Buffer.from([OPACK2_NULL]);
    }

    if (typeof obj === 'boolean') {
      return Buffer.from([obj ? OPACK2_TRUE : OPACK2_FALSE]);
    }

    if (typeof obj === 'number') {
      return this.encodeNumber(obj);
    }

    if (typeof obj === 'string') {
      return this.encodeString(obj);
    }

    if (Buffer.isBuffer(obj)) {
      return this.encodeBytes(obj);
    }

    if (Array.isArray(obj)) {
      return this.encodeArray(obj);
    }

    if (
      typeof obj === 'object' &&
      !Array.isArray(obj) &&
      !Buffer.isBuffer(obj)
    ) {
      return this.encodeDict(obj as Record<string, SerializableValue>);
    }

    throw new AppleTVError(
      `Unsupported type for OPACK2 serialization: ${typeof obj}`,
    );
  }

  /**
   * Encodes numeric values with the appropriate size optimization
   * @param num - Number to encode
   * @returns Buffer containing encoded number
   */
  private static encodeNumber(num: number): Buffer {
    if (!Number.isInteger(num) || num < 0) {
      const buffer = Buffer.allocUnsafe(5);
      buffer[0] = 0x35;
      buffer.writeFloatLE(num, 1);
      return buffer;
    }

    if (num <= OPACK2_SMALL_INT_MAX) {
      return Buffer.from([num + OPACK2_SMALL_INT_OFFSET]);
    }

    if (num <= 0xff) {
      return Buffer.from([0x30, num]);
    }

    if (num <= 0xffffffff) {
      const buffer = Buffer.allocUnsafe(5);
      buffer[0] = 0x32;
      buffer.writeUInt32LE(num, 1);
      return buffer;
    }

    if (num <= Number.MAX_SAFE_INTEGER) {
      const buffer = Buffer.allocUnsafe(9);
      buffer[0] = 0x33;
      buffer.writeBigUInt64LE(BigInt(num), 1);
      return buffer;
    }

    throw new AppleTVError(`Number too large for OPACK2 encoding: ${num}`);
  }

  /**
   * Encodes UTF-8 strings with length-optimized headers
   * @param str - String to encode
   * @returns Buffer containing encoded string
   */
  private static encodeString(str: string): Buffer {
    const encoded = Buffer.from(str, 'utf8');
    const length = encoded.length;

    if (length <= OPACK2_SMALL_STRING_MAX) {
      return Buffer.concat([Buffer.from([0x40 + length]), encoded]);
    }

    if (length <= 0xff) {
      return Buffer.concat([Buffer.from([0x61, length]), encoded]);
    }

    if (length <= 0xffff) {
      const header = Buffer.allocUnsafe(3);
      header[0] = 0x62;
      header.writeUInt16BE(length, 1);
      return Buffer.concat([header, encoded]);
    }

    if (length <= 0xffffffff) {
      const header = Buffer.allocUnsafe(5);
      header[0] = 0x63;
      header.writeUInt32BE(length, 1);
      return Buffer.concat([header, encoded]);
    }

    throw new AppleTVError(
      `String too long for OPACK2 encoding: ${length} bytes`,
    );
  }

  /**
   * Encodes binary data with length-optimized headers
   * @param bytes - Buffer to encode
   * @returns Buffer containing encoded binary data
   */
  private static encodeBytes(bytes: Buffer): Buffer {
    const length = bytes.length;

    if (length <= OPACK2_SMALL_BYTES_MAX) {
      return Buffer.concat([Buffer.from([0x70 + length]), bytes]);
    }

    if (length <= 0xff) {
      return Buffer.concat([Buffer.from([0x91, length]), bytes]);
    }

    if (length <= 0xffff) {
      const header = Buffer.allocUnsafe(3);
      header[0] = 0x92;
      header.writeUInt16BE(length, 1);
      return Buffer.concat([header, bytes]);
    }

    if (length <= 0xffffffff) {
      const header = Buffer.allocUnsafe(5);
      header[0] = 0x93;
      header.writeUInt32BE(length, 1);
      return Buffer.concat([header, bytes]);
    }

    throw new AppleTVError(
      `Byte array too long for OPACK2 encoding: ${length} bytes`,
    );
  }

  /**
   * Encodes arrays with count-optimized headers
   * @param arr - Array to encode
   * @returns Buffer containing encoded array
   */
  private static encodeArray(arr: SerializableValue[]): Buffer {
    const length = arr.length;

    if (length < OPACK2_SMALL_ARRAY_MAX) {
      const parts = [Buffer.from([0xd0 + length])];
      for (const item of arr) {
        parts.push(Buffer.from(this.encode(item)));
      }
      return Buffer.concat(parts);
    }

    const parts = [Buffer.from([0xdf])];
    for (const item of arr) {
      parts.push(Buffer.from(this.encode(item)));
    }
    parts.push(Buffer.from([OPACK2_NULL]));
    return Buffer.concat(parts);
  }

  /**
   * Encodes objects/dictionaries with count-optimized headers
   * @param dict - Object to encode
   * @returns Buffer containing encoded dictionary
   */
  private static encodeDict(dict: Record<string, SerializableValue>): Buffer {
    const entries = Object.entries(dict);
    const length = entries.length;

    if (length < OPACK2_SMALL_DICT_MAX) {
      const parts = [Buffer.from([0xe0 + length])];
      for (const [key, value] of entries) {
        parts.push(Buffer.from(this.encode(key)));
        parts.push(Buffer.from(this.encode(value)));
      }
      return Buffer.concat(parts);
    }

    const parts = [Buffer.from([0xef])];
    for (const [key, value] of entries) {
      parts.push(Buffer.from(this.encode(key)));
      parts.push(Buffer.from(this.encode(value)));
    }
    parts.push(Buffer.from([OPACK2_NULL, OPACK2_NULL]));
    return Buffer.concat(parts);
  }
}
