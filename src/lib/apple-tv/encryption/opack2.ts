import * as constants from '../constants.js';
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
   * Deserializes an OPACK2 buffer into a JavaScript value.
   *
   * @param data - Buffer containing one OPACK2 value
   * @returns The decoded JavaScript value
   * @throws AppleTVError if the buffer is malformed or contains unsupported markers
   */
  static loads(data: Buffer): SerializableValue {
    const { value, offset } = this.decode(data, 0);
    if (offset !== data.length) {
      throw new AppleTVError(
        `Trailing bytes after OPACK2 payload: ${data.length - offset}`,
      );
    }
    return value;
  }

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
      return Buffer.from([constants.OPACK2_NULL]);
    }

    if (typeof obj === 'boolean') {
      return Buffer.from([
        obj ? constants.OPACK2_TRUE : constants.OPACK2_FALSE,
      ]);
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

  private static decode(
    data: Buffer,
    offset: number,
  ): { value: SerializableValue; offset: number } {
    this.ensureAvailable(data, offset, 1);
    const marker = data[offset++];

    if (marker === constants.OPACK2_NULL) {
      return { value: null, offset };
    }
    if (marker === constants.OPACK2_TRUE) {
      return { value: true, offset };
    }
    if (marker === constants.OPACK2_FALSE) {
      return { value: false, offset };
    }

    if (
      marker >= constants.OPACK2_SMALL_INT_OFFSET &&
      marker <=
        constants.OPACK2_SMALL_INT_OFFSET + constants.OPACK2_SMALL_INT_MAX
    ) {
      return { value: marker - constants.OPACK2_SMALL_INT_OFFSET, offset };
    }

    if (marker === constants.OPACK2_INT8_MARKER) {
      this.ensureAvailable(data, offset, 1);
      return { value: data[offset], offset: offset + 1 };
    }
    if (marker === constants.OPACK2_INT32_MARKER) {
      this.ensureAvailable(data, offset, 4);
      return { value: data.readUInt32LE(offset), offset: offset + 4 };
    }
    if (marker === constants.OPACK2_INT64_MARKER) {
      this.ensureAvailable(data, offset, 8);
      const value = data.readBigUInt64LE(offset);
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new AppleTVError(
          `OPACK2 integer exceeds JavaScript safe integer range: ${value}`,
        );
      }
      return { value: Number(value), offset: offset + 8 };
    }
    if (marker === constants.OPACK2_FLOAT_MARKER) {
      this.ensureAvailable(data, offset, 4);
      return { value: data.readFloatLE(offset), offset: offset + 4 };
    }

    if (
      marker >= constants.OPACK2_SMALL_STRING_BASE &&
      marker <=
        constants.OPACK2_SMALL_STRING_BASE + constants.OPACK2_SMALL_STRING_MAX
    ) {
      const length = marker - constants.OPACK2_SMALL_STRING_BASE;
      return this.decodeString(data, offset, length);
    }
    if (marker === constants.OPACK2_STRING_8BIT_LEN_MARKER) {
      const { length, offset: valueOffset } = this.decodeLength(
        data,
        offset,
        1,
      );
      return this.decodeString(data, valueOffset, length);
    }
    if (marker === constants.OPACK2_STRING_16BIT_LEN_MARKER) {
      const { length, offset: valueOffset } = this.decodeLength(
        data,
        offset,
        2,
      );
      return this.decodeString(data, valueOffset, length);
    }
    if (marker === constants.OPACK2_STRING_32BIT_LEN_MARKER) {
      const { length, offset: valueOffset } = this.decodeLength(
        data,
        offset,
        4,
      );
      return this.decodeString(data, valueOffset, length);
    }

    if (
      marker >= constants.OPACK2_SMALL_BYTES_BASE &&
      marker <=
        constants.OPACK2_SMALL_BYTES_BASE + constants.OPACK2_SMALL_BYTES_MAX
    ) {
      const length = marker - constants.OPACK2_SMALL_BYTES_BASE;
      return this.decodeBytes(data, offset, length);
    }
    if (marker === constants.OPACK2_BYTES_8BIT_LEN_MARKER) {
      const { length, offset: valueOffset } = this.decodeLength(
        data,
        offset,
        1,
      );
      return this.decodeBytes(data, valueOffset, length);
    }
    if (marker === constants.OPACK2_BYTES_16BIT_LEN_MARKER) {
      const { length, offset: valueOffset } = this.decodeLength(
        data,
        offset,
        2,
      );
      return this.decodeBytes(data, valueOffset, length);
    }
    if (marker === constants.OPACK2_BYTES_32BIT_LEN_MARKER) {
      const { length, offset: valueOffset } = this.decodeLength(
        data,
        offset,
        4,
      );
      return this.decodeBytes(data, valueOffset, length);
    }

    if (
      marker >= constants.OPACK2_SMALL_ARRAY_BASE &&
      marker < constants.OPACK2_VARIABLE_ARRAY_MARKER
    ) {
      return this.decodeFixedArray(
        data,
        offset,
        marker - constants.OPACK2_SMALL_ARRAY_BASE,
      );
    }
    if (marker === constants.OPACK2_VARIABLE_ARRAY_MARKER) {
      return this.decodeVariableArray(data, offset);
    }

    if (
      marker >= constants.OPACK2_SMALL_DICT_BASE &&
      marker < constants.OPACK2_VARIABLE_DICT_MARKER
    ) {
      return this.decodeFixedDict(
        data,
        offset,
        marker - constants.OPACK2_SMALL_DICT_BASE,
      );
    }
    if (marker === constants.OPACK2_VARIABLE_DICT_MARKER) {
      return this.decodeVariableDict(data, offset);
    }

    throw new AppleTVError(
      `Unsupported OPACK2 marker: 0x${marker.toString(16)}`,
    );
  }

  private static decodeBytes(
    data: Buffer,
    offset: number,
    length: number,
  ): { value: Buffer; offset: number } {
    this.ensureAvailable(data, offset, length);
    return {
      value: data.subarray(offset, offset + length),
      offset: offset + length,
    };
  }

  private static decodeFixedArray(
    data: Buffer,
    offset: number,
    length: number,
  ): { value: SerializableArray; offset: number } {
    const result: SerializableArray = [];
    let currentOffset = offset;
    for (let i = 0; i < length; i++) {
      const decoded = this.decode(data, currentOffset);
      result.push(decoded.value);
      currentOffset = decoded.offset;
    }
    return { value: result, offset: currentOffset };
  }

  private static decodeFixedDict(
    data: Buffer,
    offset: number,
    length: number,
  ): { value: SerializableObject; offset: number } {
    const result: SerializableObject = {};
    let currentOffset = offset;
    for (let i = 0; i < length; i++) {
      const key = this.decode(data, currentOffset);
      if (typeof key.value !== 'string') {
        throw new AppleTVError('OPACK2 dictionary key is not a string');
      }
      const value = this.decode(data, key.offset);
      result[key.value] = value.value;
      currentOffset = value.offset;
    }
    return { value: result, offset: currentOffset };
  }

  private static decodeLength(
    data: Buffer,
    offset: number,
    byteLength: 1 | 2 | 4,
  ): { length: number; offset: number } {
    this.ensureAvailable(data, offset, byteLength);
    if (byteLength === 1) {
      return { length: data[offset], offset: offset + 1 };
    }
    if (byteLength === 2) {
      return { length: data.readUInt16BE(offset), offset: offset + 2 };
    }
    return { length: data.readUInt32BE(offset), offset: offset + 4 };
  }

  private static decodeString(
    data: Buffer,
    offset: number,
    length: number,
  ): { value: string; offset: number } {
    this.ensureAvailable(data, offset, length);
    return {
      value: data.subarray(offset, offset + length).toString('utf8'),
      offset: offset + length,
    };
  }

  private static decodeVariableArray(
    data: Buffer,
    offset: number,
  ): { value: SerializableArray; offset: number } {
    const result: SerializableArray = [];
    let currentOffset = offset;
    while (true) {
      const decoded = this.decode(data, currentOffset);
      currentOffset = decoded.offset;
      if (decoded.value === null) {
        return { value: result, offset: currentOffset };
      }
      result.push(decoded.value);
    }
  }

  private static decodeVariableDict(
    data: Buffer,
    offset: number,
  ): { value: SerializableObject; offset: number } {
    const result: SerializableObject = {};
    let currentOffset = offset;
    while (true) {
      const key = this.decode(data, currentOffset);
      const value = this.decode(data, key.offset);
      currentOffset = value.offset;
      if (key.value === null && value.value === null) {
        return { value: result, offset: currentOffset };
      }
      if (typeof key.value !== 'string') {
        throw new AppleTVError('OPACK2 dictionary key is not a string');
      }
      result[key.value] = value.value;
    }
  }

  private static ensureAvailable(
    data: Buffer,
    offset: number,
    length: number,
  ): void {
    if (offset + length > data.length) {
      throw new AppleTVError('Unexpected end of OPACK2 payload');
    }
  }

  /**
   * Encodes numeric values with the appropriate size optimization
   * @param num - Number to encode
   * @returns Buffer containing encoded number
   */
  private static encodeNumber(num: number): Buffer {
    if (!Number.isInteger(num) || num < 0) {
      const buffer = Buffer.allocUnsafe(5);
      buffer[0] = constants.OPACK2_FLOAT_MARKER;
      buffer.writeFloatLE(num, 1);
      return buffer;
    }

    if (num <= constants.OPACK2_SMALL_INT_MAX) {
      return Buffer.from([num + constants.OPACK2_SMALL_INT_OFFSET]);
    }

    if (num <= constants.OPACK2_UINT8_MAX) {
      return Buffer.from([constants.OPACK2_INT8_MARKER, num]);
    }

    if (num <= constants.OPACK2_UINT32_MAX) {
      const buffer = Buffer.allocUnsafe(5);
      buffer[0] = constants.OPACK2_INT32_MARKER;
      buffer.writeUInt32LE(num, 1);
      return buffer;
    }

    if (num <= Number.MAX_SAFE_INTEGER) {
      const buffer = Buffer.allocUnsafe(9);
      buffer[0] = constants.OPACK2_INT64_MARKER;
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

    if (length <= constants.OPACK2_SMALL_STRING_MAX) {
      return Buffer.concat([
        Buffer.from([constants.OPACK2_SMALL_STRING_BASE + length]),
        encoded,
      ]);
    }

    if (length <= constants.OPACK2_UINT8_MAX) {
      return Buffer.concat([
        Buffer.from([constants.OPACK2_STRING_8BIT_LEN_MARKER, length]),
        encoded,
      ]);
    }

    if (length <= constants.OPACK2_UINT16_MAX) {
      const header = Buffer.allocUnsafe(3);
      header[0] = constants.OPACK2_STRING_16BIT_LEN_MARKER;
      header.writeUInt16BE(length, 1);
      return Buffer.concat([header, encoded]);
    }

    if (length <= constants.OPACK2_UINT32_MAX) {
      const header = Buffer.allocUnsafe(5);
      header[0] = constants.OPACK2_STRING_32BIT_LEN_MARKER;
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

    if (length <= constants.OPACK2_SMALL_BYTES_MAX) {
      return Buffer.concat([
        Buffer.from([constants.OPACK2_SMALL_BYTES_BASE + length]),
        bytes,
      ]);
    }

    if (length <= constants.OPACK2_UINT8_MAX) {
      return Buffer.concat([
        Buffer.from([constants.OPACK2_BYTES_8BIT_LEN_MARKER, length]),
        bytes,
      ]);
    }

    if (length <= constants.OPACK2_UINT16_MAX) {
      const header = Buffer.allocUnsafe(3);
      header[0] = constants.OPACK2_BYTES_16BIT_LEN_MARKER;
      header.writeUInt16BE(length, 1);
      return Buffer.concat([header, bytes]);
    }

    if (length <= constants.OPACK2_UINT32_MAX) {
      const header = Buffer.allocUnsafe(5);
      header[0] = constants.OPACK2_BYTES_32BIT_LEN_MARKER;
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

    if (length <= constants.OPACK2_SMALL_ARRAY_MAX) {
      const parts: Buffer[] = [
        Buffer.from([constants.OPACK2_SMALL_ARRAY_BASE + length]),
      ];
      for (const item of arr) {
        parts.push(this.encode(item));
      }
      return Buffer.concat(parts);
    }

    const parts: Buffer[] = [
      Buffer.from([constants.OPACK2_VARIABLE_ARRAY_MARKER]),
    ];
    for (const item of arr) {
      parts.push(this.encode(item));
    }
    parts.push(Buffer.from([constants.OPACK2_NULL]));
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

    if (length < constants.OPACK2_SMALL_DICT_MAX) {
      const parts: Buffer[] = [
        Buffer.from([constants.OPACK2_SMALL_DICT_BASE + length]),
      ];
      for (const [key, value] of entries) {
        parts.push(this.encode(key));
        parts.push(this.encode(value));
      }
      return Buffer.concat(parts);
    }

    const parts: Buffer[] = [
      Buffer.from([constants.OPACK2_VARIABLE_DICT_MARKER]),
    ];
    for (const [key, value] of entries) {
      parts.push(this.encode(key));
      parts.push(this.encode(value));
    }
    parts.push(Buffer.from([constants.OPACK2_NULL, constants.OPACK2_NULL]));
    return Buffer.concat(parts);
  }
}
