import type { XPCArray, XPCDictionary, XPCValue } from '../types.js';

// Constants for XPC protocol.
const BODY_VERSION: number = 0x00000005;
const WRAPPER_MAGIC: number = 0x29b00b92;
const OBJECT_MAGIC: number = 0x42133742;

export const XPC_TYPES: { [key: string]: number } = {
  null: 0x00001000,
  bool: 0x00002000,
  int64: 0x00003000,
  uint64: 0x00004000,
  double: 0x00005000,
  date: 0x00007000,
  data: 0x00008000,
  string: 0x00009000,
  uuid: 0x0000a000,
  array: 0x0000e000,
  dictionary: 0x0000f000,
  fileTransfer: 0x0001a000,
};

// Helper: calculates padding bytes needed to align a length to a multiple of 4.
function calcPadding(len: number): number {
  return (4 - (len % 4)) % 4;
}

// A simple binary writer that collects Buffer chunks.
class Writer {
  private chunks: Buffer[] = [];

  writeBuffer(buf: Buffer): void {
    this.chunks.push(buf);
  }

  writeUInt32LE(value: number): void {
    const buf = Buffer.alloc(4);
    buf.writeUInt32LE(value, 0);
    this.writeBuffer(buf);
  }

  writeBigUInt64LE(value: bigint | number): void {
    const buf = Buffer.alloc(8);
    if (typeof value === 'bigint') {
      buf.writeBigUInt64LE(value, 0);
    } else {
      buf.writeBigUInt64LE(BigInt(value), 0);
    }
    this.writeBuffer(buf);
  }

  writeBigInt64LE(value: bigint): void {
    const buf = Buffer.alloc(8);
    buf.writeBigInt64LE(value, 0);
    this.writeBuffer(buf);
  }

  writeDoubleLE(value: number): void {
    const buf = Buffer.alloc(8);
    buf.writeDoubleLE(value, 0);
    this.writeBuffer(buf);
  }

  writeByte(value: number): void {
    const buf = Buffer.alloc(1);
    buf.writeUInt8(value, 0);
    this.writeBuffer(buf);
  }

  writePadding(len: number): void {
    if (len > 0) {
      this.writeBuffer(Buffer.alloc(len));
    }
  }

  concat(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

// A simple binary reader that uses an offset to traverse a Buffer.
class Reader {
  private offset: number = 0;

  constructor(private buffer: Buffer) {}

  readUInt32LE(): number {
    const val = this.buffer.readUInt32LE(this.offset);
    this.offset += 4;
    return val;
  }

  readBigUInt64LE(): bigint {
    const val = this.buffer.readBigUInt64LE(this.offset);
    this.offset += 8;
    return val;
  }

  readBigInt64LE(): bigint {
    const val = this.buffer.readBigInt64LE(this.offset);
    this.offset += 8;
    return val;
  }

  readDoubleLE(): number {
    const val = this.buffer.readDoubleLE(this.offset);
    this.offset += 8;
    return val;
  }

  readByte(): number {
    const val = this.buffer.readUInt8(this.offset);
    this.offset += 1;
    return val;
  }

  readBytes(n: number): Buffer {
    const buf = this.buffer.slice(this.offset, this.offset + n);
    this.offset += n;
    return buf;
  }

  skip(n: number): void {
    this.offset += n;
  }
}

// Interface for an XPC message.
export interface XPCMessage {
  flags: number;
  id?: bigint | number;
  body?: XPCDictionary | null;
  size?: number;
}

/**
 * Encodes a message object into an XPC Buffer.
 * A message is an object like:
 *   { flags: Number, id: bigint, body: Object|null }
 */
export function encodeMessage(message: XPCMessage): Buffer {
  const writer = new Writer();

  // Provide defaults if id or body is not provided.
  const messageId: bigint | number = message.id ?? BigInt(0);
  const body = message.body === undefined ? null : message.body;

  // Write the wrapper magic number.
  writer.writeUInt32LE(WRAPPER_MAGIC);

  if (body === null) {
    writer.writeUInt32LE(message.flags);
    writer.writeBigUInt64LE(BigInt(0));
    writer.writeBigUInt64LE(messageId);
    return writer.concat();
  }

  // Encode the message body (a dictionary) into a temporary buffer.
  const bodyWriter = new Writer();
  encodeDictionary(bodyWriter, body);
  const bodyBuffer = bodyWriter.concat();

  // Write header: flags, BodyLen (payload length + 8 for the body header), msg id.
  writer.writeUInt32LE(message.flags);
  writer.writeBigUInt64LE(BigInt(bodyBuffer.length + 8));
  writer.writeBigUInt64LE(messageId);

  // Write body header: object magic number and version.
  writer.writeUInt32LE(OBJECT_MAGIC);
  writer.writeUInt32LE(BODY_VERSION);

  // Write the actual body payload.
  writer.writeBuffer(bodyBuffer);
  return writer.concat();
}

/**
 * Decodes an XPC Buffer into a message object.
 * (Keep this function if you plan to handle incoming messages.)
 */
export function decodeMessage(buffer: Buffer): XPCMessage {
  const reader = new Reader(buffer);
  const magic = reader.readUInt32LE();
  if (magic !== WRAPPER_MAGIC) {
    throw new Error(`Invalid wrapper magic: 0x${magic.toString(16)}`);
  }
  const flags = reader.readUInt32LE();
  const bodyLen = reader.readBigUInt64LE();
  const msgId = reader.readBigUInt64LE();
  if (bodyLen === BigInt(0)) {
    return { flags, id: msgId, body: null };
  }
  // Read body header.
  const objMagic = reader.readUInt32LE();
  const version = reader.readUInt32LE();
  if (objMagic !== OBJECT_MAGIC) {
    throw new Error(`Invalid object magic: 0x${objMagic.toString(16)}`);
  }
  if (version !== BODY_VERSION) {
    throw new Error(`Unexpected body version: 0x${version.toString(16)}`);
  }
  // The remaining body is (bodyLen - 8) bytes.
  const bodyPayloadLength = Number(bodyLen) - 8;
  const bodyBuffer = reader.readBytes(bodyPayloadLength);
  const decodedValue = decodeObject(new Reader(bodyBuffer));

  // Ensure the decoded value is a dictionary
  if (
    typeof decodedValue !== 'object' ||
    decodedValue === null ||
    Array.isArray(decodedValue)
  ) {
    throw new TypeError('Expected dictionary as message body');
  }

  return { flags, id: msgId, body: decodedValue as XPCDictionary };
}

/**
 * Encodes a JavaScript object (dictionary) into XPC format.
 */
function encodeDictionary(writer: Writer, dict: XPCDictionary): void {
  const inner = new Writer();
  const keys = Object.keys(dict);
  // Write the number of dictionary entries (uint32).
  inner.writeUInt32LE(keys.length);
  for (const key of keys) {
    encodeDictionaryKey(inner, key);
    encodeObject(inner, dict[key]);
  }
  const payload = inner.concat();
  // Write dictionary type.
  writer.writeUInt32LE(XPC_TYPES.dictionary);
  // Write payload length (uint32).
  writer.writeUInt32LE(payload.length);
  writer.writeBuffer(payload);
}

/**
 * Encodes a dictionary key: writes the key string followed by a null terminator and padding.
 */
function encodeDictionaryKey(writer: Writer, key: string): void {
  const keyBuf = Buffer.from(key, 'utf8');
  const len = keyBuf.length + 1; // +1 for null terminator.
  writer.writeBuffer(keyBuf);
  writer.writeByte(0); // null terminator.
  const pad = calcPadding(len);
  writer.writePadding(pad);
}

/**
 * Encodes a JavaScript value into XPC format.
 * Supports: null, booleans, numbers (as int64 or double), strings, Date, Buffer/Uint8Array, arrays, and objects.
 */
function encodeObject(writer: Writer, value: XPCValue): void {
  if (value === null || value === undefined) {
    writer.writeUInt32LE(XPC_TYPES.null);
    return;
  }
  if (typeof value === 'boolean') {
    writer.writeUInt32LE(XPC_TYPES.bool);
    writer.writeByte(value ? 1 : 0);
    writer.writePadding(3); // 3 bytes padding.
    return;
  }
  if (typeof value === 'number') {
    if (Number.isInteger(value)) {
      writer.writeUInt32LE(XPC_TYPES.int64);
      writer.writeBigInt64LE(BigInt(value));
    } else {
      writer.writeUInt32LE(XPC_TYPES.double);
      writer.writeDoubleLE(value);
    }
    return;
  }
  if (typeof value === 'string') {
    writer.writeUInt32LE(XPC_TYPES.string);
    const strBuf = Buffer.from(value, 'utf8');
    const len = strBuf.length + 1; // include null terminator.
    writer.writeUInt32LE(len);
    writer.writeBuffer(strBuf);
    writer.writeByte(0);
    const pad = calcPadding(len);
    writer.writePadding(pad);
    return;
  }
  if (value instanceof Date) {
    writer.writeUInt32LE(XPC_TYPES.date);
    // Encode time in nanoseconds (Date.getTime() gives milliseconds).
    writer.writeBigInt64LE(BigInt(value.getTime()) * BigInt(1000000));
    return;
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
    writer.writeUInt32LE(XPC_TYPES.data);
    writer.writeUInt32LE(data.length);
    writer.writeBuffer(data);
    const pad = calcPadding(data.length);
    writer.writePadding(pad);
    return;
  }
  if (Array.isArray(value)) {
    const inner = new Writer();
    for (let i = 0; i < value.length; i++) {
      encodeObject(inner, value[i]);
    }
    const payload = inner.concat();
    writer.writeUInt32LE(XPC_TYPES.array);
    writer.writeUInt32LE(payload.length); // payload length.
    writer.writeUInt32LE(value.length); // number of objects.
    writer.writeBuffer(payload);
    return;
  }
  if (typeof value === 'object') {
    // Treat as a dictionary.
    encodeDictionary(writer, value);
    return;
  }
  throw new TypeError('Unsupported type: ' + typeof value);
}

/**
 * Decodes an XPC object from the provided reader.
 */
function decodeObject(reader: Reader): XPCValue {
  const type = reader.readUInt32LE();
  switch (type) {
    case XPC_TYPES.null:
      return null;
    case XPC_TYPES.bool: {
      const b = reader.readByte();
      reader.skip(3);
      return Boolean(b);
    }
    case XPC_TYPES.int64:
      return Number(reader.readBigInt64LE());
    case XPC_TYPES.uint64:
      return Number(reader.readBigUInt64LE());
    case XPC_TYPES.double:
      return reader.readDoubleLE();
    case XPC_TYPES.date: {
      // Date is encoded as int64 nanoseconds.
      const ns = reader.readBigInt64LE();
      return new Date(Number(ns / BigInt(1000000)));
    }
    case XPC_TYPES.data: {
      const dataLen = reader.readUInt32LE();
      const data = reader.readBytes(dataLen);
      const pad = calcPadding(dataLen);
      reader.skip(pad);
      return data;
    }
    case XPC_TYPES.string: {
      const strLen = reader.readUInt32LE();
      const strBuf = reader.readBytes(strLen);
      // Remove the trailing null terminator.
      const nullIndex = strBuf.indexOf(0);
      const str = strBuf.slice(0, nullIndex).toString('utf8');
      const pad = calcPadding(strLen);
      reader.skip(pad);
      return str;
    }
    case XPC_TYPES.uuid: {
      const uuidBuf = reader.readBytes(16);
      return uuidBuf.toString('hex'); // Return UUID as hex string.
    }
    case XPC_TYPES.array: {
      const numElements = reader.readUInt32LE();
      const arr: XPCArray = [];
      for (let i = 0; i < numElements; i++) {
        arr.push(decodeObject(reader));
      }
      return arr;
    }
    case XPC_TYPES.dictionary:
      return decodeDictionary(reader);
    // Note: fileTransfer type is not implemented here.
    default:
      throw new TypeError(`Unsupported xpc type: 0x${type.toString(16)}`);
  }
}

/**
 * Decodes a dictionary from the reader.
 */
function decodeDictionary(reader: Reader): XPCDictionary {
  const numEntries = reader.readUInt32LE();
  const dict: XPCDictionary = {};
  for (let i = 0; i < numEntries; i++) {
    const key = readDictionaryKey(reader);
    dict[key] = decodeObject(reader);
  }
  return dict;
}

/**
 * Reads a dictionary key: reads bytes until a null terminator is encountered then skips padding.
 */
function readDictionaryKey(reader: Reader): string {
  const bytes: number[] = [];
  while (true) {
    const b = reader.readByte();
    if (b === 0) {
      break;
    }
    bytes.push(b);
  }
  const key = Buffer.from(bytes).toString('utf8');
  const pad = calcPadding(key.length + 1);
  reader.skip(pad);
  return key;
}
