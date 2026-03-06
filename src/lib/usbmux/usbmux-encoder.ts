import { Transform, type TransformCallback } from 'node:stream';

import { createPlist } from '../plist/index.js';
import type { PlistDictionary } from '../types.js';

const HEADER_LENGTH = 16;
const VERSION = 1;
const TYPE = 8;

export interface UsbmuxEncodeData {
  payload: PlistDictionary; // Using PlistDictionary for the payload
  tag: number;
}

export class UsbmuxEncoder extends Transform {
  constructor() {
    super({ objectMode: true });
  }

  _transform(
    data: UsbmuxEncodeData,
    encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    this._encode(data);
    callback();
  }

  private _encode(data: UsbmuxEncodeData): void {
    const plistData = createPlist(data.payload, false);
    const payloadBuffer = Buffer.isBuffer(plistData)
      ? plistData
      : Buffer.from(plistData);

    const header = {
      length: HEADER_LENGTH + payloadBuffer.length,
      version: VERSION,
      type: TYPE,
      tag: data.tag,
    };

    const headerBuffer = Buffer.allocUnsafe(HEADER_LENGTH);
    headerBuffer.writeUInt32LE(header.length, 0);
    headerBuffer.writeUInt32LE(header.version, 4);
    headerBuffer.writeUInt32LE(header.type, 8);
    headerBuffer.writeUInt32LE(header.tag, 12);

    this.push(
      Buffer.concat(
        [headerBuffer, payloadBuffer],
        headerBuffer.length + payloadBuffer.length,
      ),
    );
  }
}
