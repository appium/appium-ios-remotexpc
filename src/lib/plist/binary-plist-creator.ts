/**
 * Binary Property List (bplist) Creator
 *
 * This module provides functionality to create binary property lists (bplists)
 * commonly used in Apple's iOS and macOS systems.
 */
import type { PlistDictionary, PlistValue } from '../types.js';
import {
  APPLE_EPOCH_OFFSET,
  BPLIST_MAGIC_AND_VERSION,
  BPLIST_TRAILER_SIZE,
  BPLIST_TYPE,
} from './constants.js';

/**
 * Checks if a value is a plain object (not null, not an array, not a Date, not a Buffer)
 * @param value - The value to check
 * @returns True if the value is a plain object
 */
function isPlainObject(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Date) &&
    !(value instanceof Buffer) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

/**
 * Class for creating binary property lists
 */
class BinaryPlistCreator {
  private _objectTable: PlistValue[] = [];
  private _objectRefMap = new Map<PlistValue, number>();
  private _objectRefSize: number = 0;
  private _offsetSize: number = 0;
  private readonly _rootObject: PlistValue;

  /**
   * Creates a new BinaryPlistCreator
   * @param rootObject - The root object to convert to a binary plist
   */
  constructor(rootObject: PlistValue) {
    this._rootObject = rootObject;
  }

  /**
   * Creates the binary plist
   * @returns Buffer containing the binary plist data
   */
  create(): Buffer {
    // Collect all objects and assign IDs
    this._collectObjects();

    // Create object data
    const objectOffsets: number[] = [];
    const objectData: Buffer[] = [];

    for (const value of this._objectTable) {
      // Calculate offset including the header length
      objectOffsets.push(
        BPLIST_MAGIC_AND_VERSION.length +
          this._calculateObjectDataLength(objectData),
      );
      objectData.push(this._createObjectData(value));
    }

    // Calculate offset table size
    const maxOffset = this._calculateObjectDataLength(objectData);
    this._offsetSize = this._calculateMinByteSize(maxOffset);

    // Create offset table
    const offsetTable = this._createOffsetTable(objectOffsets);

    // Calculate offset table offset
    const offsetTableOffset =
      BPLIST_MAGIC_AND_VERSION.length +
      this._calculateObjectDataLength(objectData);

    // Create trailer
    const trailer = this._createTrailer(
      this._objectTable.length,
      offsetTableOffset,
    );

    // Combine all parts
    return Buffer.concat([
      BPLIST_MAGIC_AND_VERSION,
      ...objectData,
      offsetTable,
      trailer,
    ]);
  }

  /**
   * Collects all unique objects in the object hierarchy
   */
  private _collectObjects(): void {
    this._collectObjectsRecursive(this._rootObject);

    // Calculate the object reference size based on the number of objects
    const numObjects = this._objectTable.length;
    this._objectRefSize = this._calculateMinByteSize(numObjects - 1);
  }

  /**
   * Recursively collects objects from a value
   * @param value - The value to collect objects from
   */
  private _collectObjectsRecursive(value: PlistValue): void {
    // Skip if already in the table
    if (this._objectRefMap.has(value)) {
      return;
    }

    // Add to the table and map
    const id = this._objectTable.length;
    this._objectTable.push(value);
    this._objectRefMap.set(value, id);

    // Recursively collect objects for arrays and dictionaries
    if (Array.isArray(value)) {
      for (const item of value) {
        this._collectObjectsRecursive(item);
      }
    } else if (value !== null && isPlainObject(value)) {
      // This is a dictionary
      const dict = value as PlistDictionary;
      for (const key of Object.keys(dict)) {
        this._collectObjectsRecursive(key);
        this._collectObjectsRecursive(dict[key]);
      }
    }
  }

  /**
   * Calculates the minimum number of bytes needed to represent a number
   * @param value - The number to calculate for
   * @returns The minimum number of bytes needed (1, 2, 4, or 8)
   */
  private _calculateMinByteSize(value: number): number {
    if (value < 256) {
      return 1;
    } else if (value < 65536) {
      return 2;
    } else if (value < 4294967296) {
      return 4;
    } else {
      return 8;
    }
  }

  /**
   * Calculates the total length of object data buffers
   * @param buffers - Array of buffers
   * @returns Total length
   */
  private _calculateObjectDataLength(buffers: Buffer[]): number {
    return buffers.reduce((sum, buffer) => sum + buffer.length, 0);
  }

  /**
   * Writes an offset value to a buffer
   * @param buffer - Target buffer
   * @param position - Position in the buffer
   * @param value - Value to write
   * @param size - Number of bytes to use
   */
  private _writeOffsetToBuffer(
    buffer: Buffer,
    position: number,
    value: number | bigint,
    size: number,
  ): void {
    if (size === 1) {
      buffer.writeUInt8(Number(value), position);
    } else if (size === 2) {
      buffer.writeUInt16BE(Number(value), position);
    } else if (size === 4) {
      buffer.writeUInt32BE(Number(value), position);
    } else if (size === 8) {
      // Use BigInt directly for the value to avoid potential precision issues
      buffer.writeBigUInt64BE(
        typeof value === 'bigint' ? value : BigInt(value),
        position,
      );
    }
  }

  /**
   * Writes a BigInt to a buffer
   * @param buffer - Target buffer
   * @param position - Position in the buffer
   * @param value - BigInt value to write
   */
  private _writeBigIntToBuffer(
    buffer: Buffer,
    position: number,
    value: bigint,
  ): void {
    buffer.writeBigUInt64BE(value, position);
  }

  /**
   * Creates binary data for a null value
   * @returns Buffer containing the binary data
   */
  private _createNullData(): Buffer {
    return Buffer.from([BPLIST_TYPE.NULL]);
  }

  /**
   * Creates binary data for a boolean value
   * @param value - The boolean value
   * @returns Buffer containing the binary data
   */
  private _createBooleanData(value: boolean): Buffer {
    return Buffer.from([value ? BPLIST_TYPE.TRUE : BPLIST_TYPE.FALSE]);
  }

  /**
   * Creates binary data for an integer value
   * @param value - The integer value (number or bigint)
   * @returns Buffer containing the binary data
   */
  private _createIntegerData(value: number | bigint): Buffer {
    let buffer: Buffer;

    // If value is a BigInt, handle it directly
    if (typeof value === 'bigint') {
      // For BigInt values, we always use 64-bit representation
      buffer = Buffer.alloc(9);
      buffer.writeUInt8(BPLIST_TYPE.INT | 3, 0);
      buffer.writeBigInt64BE(value, 1);
    }
    // For number values, determine the smallest representation
    else if (value >= 0 && value <= 255) {
      buffer = Buffer.alloc(2);
      buffer.writeUInt8(BPLIST_TYPE.INT | 0, 0);
      buffer.writeUInt8(value, 1);
    } else if (value >= -128 && value <= 127) {
      buffer = Buffer.alloc(2);
      buffer.writeUInt8(BPLIST_TYPE.INT | 0, 0);
      buffer.writeInt8(value, 1);
    } else if (value >= -32768 && value <= 32767) {
      buffer = Buffer.alloc(3);
      buffer.writeUInt8(BPLIST_TYPE.INT | 1, 0);
      buffer.writeInt16BE(value, 1);
    } else if (value >= -2147483648 && value <= 2147483647) {
      buffer = Buffer.alloc(5);
      buffer.writeUInt8(BPLIST_TYPE.INT | 2, 0);
      buffer.writeInt32BE(value, 1);
    } else {
      // 64-bit integer - use BigInt directly to avoid precision issues
      buffer = Buffer.alloc(9);
      buffer.writeUInt8(BPLIST_TYPE.INT | 3, 0);
      buffer.writeBigInt64BE(BigInt(value), 1);
    }

    return buffer;
  }

  /**
   * Creates binary data for a floating point value
   * @param value - The floating point value
   * @returns Buffer containing the binary data
   */
  private _createFloatData(value: number): Buffer {
    const buffer = Buffer.alloc(9);
    buffer.writeUInt8(BPLIST_TYPE.REAL | 3, 0); // Use double precision
    buffer.writeDoubleBE(value, 1);
    return buffer;
  }

  /**
   * Creates binary data for a date value
   * @param value - The date value
   * @returns Buffer containing the binary data
   */
  private _createDateData(value: Date): Buffer {
    const buffer = Buffer.alloc(9);
    buffer.writeUInt8(BPLIST_TYPE.DATE, 0);
    // Convert to seconds since Apple epoch (2001-01-01)
    const timestamp = value.getTime() / 1000 - APPLE_EPOCH_OFFSET;
    buffer.writeDoubleBE(timestamp, 1);
    return buffer;
  }

  /**
   * Creates a header for an integer value
   * @param value - The integer value
   * @returns Buffer containing the integer header
   */
  private _createIntHeader(value: number): Buffer {
    let buffer: Buffer;

    if (value < 256) {
      buffer = Buffer.alloc(2);
      buffer.writeUInt8(BPLIST_TYPE.INT | 0, 0);
      buffer.writeUInt8(value, 1);
    } else if (value < 65536) {
      buffer = Buffer.alloc(3);
      buffer.writeUInt8(BPLIST_TYPE.INT | 1, 0);
      buffer.writeUInt16BE(value, 1);
    } else {
      buffer = Buffer.alloc(5);
      buffer.writeUInt8(BPLIST_TYPE.INT | 2, 0);
      buffer.writeUInt32BE(value, 1);
    }

    return buffer;
  }

  /**
   * Creates binary data for a buffer (data) value
   * @param value - The buffer value
   * @returns Buffer containing the binary data
   */
  private _createBufferData(value: Buffer): Buffer {
    const length = value.length;
    let header: Buffer;

    if (length < 15) {
      header = Buffer.from([BPLIST_TYPE.DATA | length]);
    } else {
      // For longer data, we need to encode the length separately
      const lengthBuffer = this._createIntHeader(length);
      header = Buffer.concat([
        Buffer.from([BPLIST_TYPE.DATA | 0x0f]), // 0x0F indicates length follows
        lengthBuffer,
      ]);
    }

    return Buffer.concat([header, value]);
  }

  /**
   * Creates binary data for a string value
   * @param value - The string value
   * @returns Buffer containing the binary data
   */
  private _createStringData(value: string): Buffer {
    // Check if string can be ASCII
    // eslint-disable-next-line no-control-regex
    const isAscii = /^[\x00-\x7F]*$/.test(value);

    let stringBuffer: Buffer;
    if (isAscii) {
      stringBuffer = Buffer.from(value, 'ascii');
    } else {
      // Unicode strings should be stored as UTF-16BE in binary plists
      const utf16leBuffer = Buffer.from(value, 'utf16le');
      stringBuffer = Buffer.alloc(utf16leBuffer.length);

      // Convert UTF-16LE to UTF-16BE
      for (let i = 0; i < utf16leBuffer.length; i += 2) {
        stringBuffer[i] = utf16leBuffer[i + 1]; // High byte
        stringBuffer[i + 1] = utf16leBuffer[i]; // Low byte
      }
    }

    const length = isAscii ? value.length : stringBuffer.length / 2;
    let header: Buffer;

    if (length < 15) {
      header = Buffer.from([
        isAscii
          ? BPLIST_TYPE.STRING_ASCII | length
          : BPLIST_TYPE.STRING_UNICODE | length,
      ]);
    } else {
      // For longer strings, we need to encode the length separately
      const lengthBuffer = this._createIntHeader(length);
      header = Buffer.concat([
        Buffer.from([
          isAscii
            ? BPLIST_TYPE.STRING_ASCII | 0x0f
            : BPLIST_TYPE.STRING_UNICODE | 0x0f,
        ]),
        lengthBuffer,
      ]);
    }

    return Buffer.concat([header, stringBuffer]);
  }

  /**
   * Creates binary data for an array value
   * @param value - The array value
   * @returns Buffer containing the binary data
   */
  private _createArrayData(value: PlistValue[]): Buffer {
    const length = value.length;
    let header: Buffer;

    if (length < 15) {
      header = Buffer.from([BPLIST_TYPE.ARRAY | length]);
    } else {
      // For longer arrays, we need to encode the length separately
      const lengthBuffer = this._createIntHeader(length);
      header = Buffer.concat([
        Buffer.from([BPLIST_TYPE.ARRAY | 0x0f]), // 0x0F indicates length follows
        lengthBuffer,
      ]);
    }

    // Create references to each item
    const refBuffer = Buffer.alloc(length * this._objectRefSize);
    for (let i = 0; i < length; i++) {
      const itemRef = this._objectRefMap.get(value[i]) ?? 0;
      this._writeOffsetToBuffer(
        refBuffer,
        i * this._objectRefSize,
        itemRef,
        this._objectRefSize,
      );
    }

    return Buffer.concat([header, refBuffer]);
  }

  /**
   * Creates binary data for a dictionary value
   * @param value - The dictionary value
   * @returns Buffer containing the binary data
   */
  private _createDictionaryData(value: PlistDictionary): Buffer {
    const keys = Object.keys(value);
    const length = keys.length;
    let header: Buffer;

    if (length < 15) {
      header = Buffer.from([BPLIST_TYPE.DICT | length]);
    } else {
      // For larger dictionaries, we need to encode the length separately
      const lengthBuffer = this._createIntHeader(length);
      header = Buffer.concat([
        Buffer.from([BPLIST_TYPE.DICT | 0x0f]), // 0x0F indicates length follows
        lengthBuffer,
      ]);
    }

    // Create references to keys and values
    const keyRefBuffer = Buffer.alloc(length * this._objectRefSize);
    const valueRefBuffer = Buffer.alloc(length * this._objectRefSize);

    for (let i = 0; i < length; i++) {
      const key = keys[i];
      const keyRef = this._objectRefMap.get(key) ?? 0;
      const valueRef = this._objectRefMap.get(value[key]) ?? 0;

      this._writeOffsetToBuffer(
        keyRefBuffer,
        i * this._objectRefSize,
        keyRef,
        this._objectRefSize,
      );
      this._writeOffsetToBuffer(
        valueRefBuffer,
        i * this._objectRefSize,
        valueRef,
        this._objectRefSize,
      );
    }

    return Buffer.concat([header, keyRefBuffer, valueRefBuffer]);
  }

  /**
   * Creates binary data for an object
   * @param value - The value to convert
   * @returns Buffer containing the binary data
   */
  private _createObjectData(value: PlistValue): Buffer {
    // Handle null and booleans
    if (value === null) {
      return this._createNullData();
    } else if (typeof value === 'boolean') {
      return this._createBooleanData(value);
    }

    // Handle BigInt
    if (typeof value === 'bigint') {
      return this._createIntegerData(value);
    }

    // Handle numbers
    if (typeof value === 'number') {
      // Check if it's an integer
      if (Number.isInteger(value)) {
        return this._createIntegerData(value);
      } else {
        // Float
        return this._createFloatData(value);
      }
    }

    // Handle Date
    if (value instanceof Date) {
      return this._createDateData(value);
    }

    // Handle Buffer (DATA)
    if (Buffer.isBuffer(value)) {
      return this._createBufferData(value);
    }

    // Handle strings
    if (typeof value === 'string') {
      return this._createStringData(value);
    }

    // Handle arrays
    if (Array.isArray(value)) {
      return this._createArrayData(value);
    }

    // Handle objects (dictionaries) - using isPlainObject for better type checking
    if (isPlainObject(value)) {
      return this._createDictionaryData(value as PlistDictionary);
    }

    // Default fallback
    return Buffer.from([BPLIST_TYPE.NULL]);
  }

  /**
   * Creates the offset table
   * @param objectOffsets - Array of object offsets
   * @returns Buffer containing the offset table
   */
  private _createOffsetTable(objectOffsets: number[]): Buffer {
    const numObjects = this._objectTable.length;
    const offsetTable = Buffer.alloc(numObjects * this._offsetSize);

    for (let i = 0; i < numObjects; i++) {
      this._writeOffsetToBuffer(
        offsetTable,
        i * this._offsetSize,
        objectOffsets[i],
        this._offsetSize,
      );
    }

    return offsetTable;
  }

  /**
   * Creates the trailer
   * @param numObjects - Number of objects
   * @param offsetTableOffset - Offset of the offset table
   * @returns Buffer containing the trailer
   */
  private _createTrailer(
    numObjects: number,
    offsetTableOffset: number,
  ): Buffer {
    const trailer = Buffer.alloc(BPLIST_TRAILER_SIZE);
    // 6 unused bytes
    trailer.fill(0, 0, 6);
    // offset size (1 byte)
    trailer.writeUInt8(this._offsetSize, 6);
    // object ref size (1 byte)
    trailer.writeUInt8(this._objectRefSize, 7);
    // number of objects (8 bytes)
    this._writeBigIntToBuffer(trailer, 8, BigInt(numObjects));
    // top object ID (8 bytes)
    this._writeBigIntToBuffer(trailer, 16, BigInt(0)); // Root object is always the first one
    // offset table offset (8 bytes)
    this._writeBigIntToBuffer(trailer, 24, BigInt(offsetTableOffset));

    return trailer;
  }
}

/**
 * Creates a binary plist from a JavaScript object
 * @param obj - The JavaScript object to convert to a binary plist
 * @returns Buffer containing the binary plist data
 */
export function createBinaryPlist(obj: PlistValue): Buffer {
  const creator = new BinaryPlistCreator(obj);
  return creator.create();
}
