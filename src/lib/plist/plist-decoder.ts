import { logger } from '@appium/support';
import { Transform, type TransformCallback } from 'stream';

import { UTF8_ENCODING } from './constants.js';
import { parsePlist } from './plist-parser.js';
import {
  ensureString,
  findFirstReplacementCharacter,
  fixMultipleXmlDeclarations,
  hasUnicodeReplacementCharacter,
} from './utils.js';

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

      // Check if this is XML data with potential binary header and trim content before XML declaration
      const dataStr = plistData.toString(
        UTF8_ENCODING,
        0,
        Math.min(100, plistData.length),
      );
      const xmlIndex = dataStr.indexOf('<?xml');

      if (xmlIndex > 0) {
        // There's content before the XML declaration, remove it
        log.debug(
          `Found XML declaration at position ${xmlIndex}, trimming preceding content`,
        );
        plistData = plistData.slice(xmlIndex);
      }

      // Check for multiple XML declarations which can cause parsing errors
      const fullDataStr = ensureString(plistData);

      // Check for potential corruption indicators and handle them
      if (hasUnicodeReplacementCharacter(plistData)) {
        log.debug(
          'Detected Unicode replacement characters in plist data, which may indicate encoding issues',
        );

        // Try to find and clean the corrupted data
        const firstReplacementPos = findFirstReplacementCharacter(fullDataStr);
        if (firstReplacementPos >= 0) {
          log.debug(
            `Found replacement character at position ${firstReplacementPos}, attempting to clean data`,
          );
        }
      }
      const xmlDeclMatches = fullDataStr.match(/(<\?xml[^>]*\?>)/g) || [];
      if (xmlDeclMatches.length > 1) {
        log.debug(
          `Found ${xmlDeclMatches.length} XML declarations, which may cause parsing errors`,
        );
        // Fix multiple XML declarations
        plistData = Buffer.from(fixMultipleXmlDeclarations(plistData));
      }

      try {
        // Parse the plist
        this._parseAndProcess(plistData, callback);
      } catch (error) {
        // If parsing fails, try to recover by cleaning up the data more aggressively
        const parseError = error as Error;

        try {
          // Find the first valid XML tag
          const firstTagIndex = fullDataStr.indexOf('<');
          if (firstTagIndex > 0) {
            const cleanedData = plistData.slice(firstTagIndex);
            this._parseAndProcess(cleanedData, callback);
          } else {
            // If we can't find a valid starting point, propagate the original error
            throw parseError;
          }
        } catch (error) {
          // If recovery also fails, propagate the original error
          callback(error as Error);
        }
      }
    } catch (err) {
      callback(err as Error);
    }
  }

  /**
   * Parse plist data and process the result
   *
   * @param data - The plist data to parse
   * @param callback - The transform callback
   */
  private _parseAndProcess(data: Buffer, callback: TransformCallback): void {
    const result = parsePlist(data);
    this._processResult(result, callback);
  }

  /**
   * Process a successfully parsed result
   * Stores the result in the static property and pushes it to the stream
   *
   * @param result - The parsed plist result
   * @param callback - The transform callback
   */
  private _processResult(result: any, callback: TransformCallback): void {
    // Store the result in the static property for later access
    if (typeof result === 'object' && result !== null) {
      PlistServiceDecoder.lastDecodedResult = result;
    }

    this.push(result);
    callback();
  }
}
