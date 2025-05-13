import { Transform, type TransformCallback } from 'stream';

import parsePlist from './plist-parser.js';

/**
 * Decodes plist format data with length prefix to JavaScript objects
 */
export class PlistServiceDecoder extends Transform {
  // Static property to store the last decoded result
  static lastDecodedResult: any = null;
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
      let plistData = data.slice(4);

      // Skip empty data
      if (plistData.length === 0) {
        return callback();
      }

      // Check if this is XML data with potential binary header
      const dataStr = plistData.toString(
        'utf8',
        0,
        Math.min(100, plistData.length),
      );
      const xmlIndex = dataStr.indexOf('<?xml');

      if (xmlIndex > 0) {
        // There's content before the XML declaration, remove it
        plistData = plistData.slice(xmlIndex);
      }

      // Parse the plist
      const result = parsePlist(plistData);

      // Store the result in the static property for later access
      if (typeof result === 'object' && result !== null) {
        PlistServiceDecoder.lastDecodedResult = result;
      }

      this.push(result);
      callback();
    } catch (err) {
      callback(err as Error);
    }
  }
}

export default PlistServiceDecoder;
