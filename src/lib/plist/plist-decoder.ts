import { Transform, type TransformCallback } from 'stream';
import { logger } from '@appium/support';

import parsePlist from './plist-parser.js';

const log = logger.getLogger('Plist');

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
        log.debug(`Found XML declaration at position ${xmlIndex}, trimming preceding content`);
        plistData = plistData.slice(xmlIndex);
      }

      // Check for potential corruption indicators
      if (plistData.includes(Buffer.from('�'))) {
        log.debug('Detected Unicode replacement characters in plist data, potential encoding issues');
      }

      // Check for multiple XML declarations which can cause parsing errors
      const fullDataStr = plistData.toString('utf8');
      const xmlDeclMatches = fullDataStr.match(/(<\?xml[^>]*\?>)/g) || [];
      if (xmlDeclMatches.length > 1) {
        log.debug(`Found ${xmlDeclMatches.length} XML declarations, which may cause parsing errors`);
      }

      try {
        // Parse the plist
        const result = parsePlist(plistData);

        // Store the result in the static property for later access
        if (typeof result === 'object' && result !== null) {
          PlistServiceDecoder.lastDecodedResult = result;
        }

        this.push(result);
        callback();
      } catch (error) {
        // If parsing fails, try to recover by cleaning up the data more aggressively
        const parseError = error as Error;
        log.debug(`Initial parsing failed: ${parseError.message}, attempting recovery`);
        
        try {
          // Find the first valid XML tag
          const firstTagIndex = fullDataStr.indexOf('<');
          if (firstTagIndex > 0) {
            const cleanedData = plistData.slice(firstTagIndex);
            const result = parsePlist(cleanedData);
            
            if (typeof result === 'object' && result !== null) {
              PlistServiceDecoder.lastDecodedResult = result;
            }
            
            this.push(result);
            callback();
          } else {
            // If we can't find a valid starting point, propagate the original error
            throw parseError;
          }
        } catch (error) {
          // If recovery also fails, propagate the original error
          const recoveryError = error as Error;
          log.error(`Recovery attempt failed: ${recoveryError.message}`);
          callback(parseError);
        }
      }
    } catch (err) {
      log.error(`Error in plist decoder: ${err instanceof Error ? err.message : String(err)}`);
      callback(err as Error);
    }
  }
}

export default PlistServiceDecoder;
