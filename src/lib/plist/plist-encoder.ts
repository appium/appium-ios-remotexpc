import { Transform, type TransformCallback } from 'stream';

import type { PlistDictionary } from '../types.js';
import { UTF8_ENCODING } from './constants.js';
import { createPlist } from './plist-creator.js';

/**
 * Encodes JavaScript objects to plist format with length prefix
 */
export class PlistServiceEncoder extends Transform {
  constructor() {
    super({ objectMode: true });
  }

  _transform(
    data: PlistDictionary,
    encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    try {
      // Convert object to plist
      const plist = createPlist(data);
      const plistBuffer = Buffer.from(plist, UTF8_ENCODING);

      // Create length header (4 bytes, big endian)
      const header = Buffer.alloc(4);
      header.writeUInt32BE(plistBuffer.length, 0);

      // Send header + plist
      this.push(Buffer.concat([header, plistBuffer]));
      callback();
    } catch (err) {
      callback(err as Error);
    }
  }
}
