import { Transform, type TransformCallback } from 'stream';

import createPlist from './PlistCreator.js';

/**
 * Encodes JavaScript objects to plist format with length prefix
 */
export class PlistServiceEncoder extends Transform {
  constructor() {
    super({ objectMode: true });
  }

  _transform(
    data: Record<string, any>,
    encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    try {
      // Convert object to plist
      const plist = createPlist(data);
      const plistBuffer = Buffer.from(plist, 'utf8');

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

export default PlistServiceEncoder;
