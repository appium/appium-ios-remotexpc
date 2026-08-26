import {Transform, type TransformCallback} from 'node:stream';

import {parsePlist} from '../plist/index.js';
import type {PlistDictionary} from '../types.js';

const HEADER_LENGTH = 16;

export interface UsbmuxHeader {
  length: number;
  version: number;
  type: number;
  tag: number;
}

export interface DecodedUsbmux {
  header: UsbmuxHeader;
  payload: PlistDictionary;
}

export class UsbmuxDecoder extends Transform {
  private _buffer: Buffer = Buffer.alloc(0);

  constructor() {
    super({objectMode: true});
  }

  get buffer(): Buffer {
    return this._buffer;
  }

  _transform(chunk: Buffer, encoding: BufferEncoding, callback: TransformCallback): void {
    // Append the new chunk to the internal buffer
    this._buffer = Buffer.concat([this._buffer, chunk]);

    // Process complete messages in the buffer
    while (this._buffer.length >= HEADER_LENGTH) {
      // Read header length field (total length of the message)
      const totalLength = this._buffer.readUInt32LE(0);

      // Check if we have received the full message
      if (this._buffer.length < totalLength) {
        break; // Wait for more data
      }

      // Extract the full message and remove it from the buffer before decoding,
      // so any synchronous data listeners see only the unconsumed remainder.
      const message = this._buffer.subarray(0, totalLength);
      this._buffer = this._buffer.subarray(totalLength);

      try {
        this._decode(message);
      } catch (err) {
        return callback(err instanceof Error ? err : new Error(String(err)));
      }
    }
    callback();
  }

  private _decode(data: Buffer): void {
    const header = {
      length: data.readUInt32LE(0),
      version: data.readUInt32LE(4),
      type: data.readUInt32LE(8),
      tag: data.readUInt32LE(12),
    };

    const payload = data.subarray(HEADER_LENGTH);
    this.push({header, payload: parsePlist(payload)} as DecodedUsbmux);
  }
}
