import { Transform, type TransformCallback } from 'stream';

import parsePlist from './plist-parser.js';

/**
 * Decodes plist format data with length prefix to JavaScript objects
 */
export class PlistServiceDecoder extends Transform {
  constructor() {
    super({ objectMode: true });
  }

  _transform(
    data: Buffer,
    encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    try {
      // Get the plist data without the 4-byte header
      const plistData = data.slice(4);

      // Skip empty data
      if (plistData.length === 0) {
        return callback();
      }

      // Parse the plist
      const result = parsePlist(plistData);
      this.push(result);
      callback();
    } catch (err) {
      callback(err as Error);
    }
  }
}

export default PlistServiceDecoder;
