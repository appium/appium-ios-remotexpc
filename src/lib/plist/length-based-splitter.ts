import { logger } from '@appium/support';
import { Transform, type TransformCallback } from 'stream';

import {
  BINARY_PLIST_HEADER_LENGTH,
  BINARY_PLIST_MAGIC,
  IBINARY_PLIST_MAGIC,
  LENGTH_FIELD_1_BYTE,
  LENGTH_FIELD_2_BYTES,
  LENGTH_FIELD_4_BYTES,
  LENGTH_FIELD_8_BYTES,
  PLIST_CLOSING_TAG,
  UINT32_HIGH_MULTIPLIER,
  UTF8_ENCODING,
  XML_DECLARATION,
} from './constants.js';
import { isXmlPlistContent } from './utils.js';

const log = logger.getLogger('Plist');

// Constants
const DEFAULT_MAX_FRAME_LENGTH = 100 * 1024 * 1024; // 100MB default for large IORegistry responses
const DEFAULT_LENGTH_FIELD_OFFSET = 0;
const DEFAULT_LENGTH_FIELD_LENGTH = 4;
const DEFAULT_LENGTH_ADJUSTMENT = 0;
const MAX_PREVIEW_LENGTH = 100; // Maximum number of bytes to preview for content type detection

/**
 * Options for LengthBasedSplitter
 */
export interface LengthBasedSplitterOptions {
  readableStream?: NodeJS.ReadableStream;
  littleEndian?: boolean;
  maxFrameLength?: number;
  lengthFieldOffset?: number;
  lengthFieldLength?: number;
  lengthAdjustment?: number;
}

/**
 * Splits incoming data into length-prefixed chunks
 */
export class LengthBasedSplitter extends Transform {
  private buffer: Buffer;
  private readonly littleEndian: boolean;
  private readonly maxFrameLength: number;
  private readonly lengthFieldOffset: number;
  private readonly lengthFieldLength: number;
  private readonly lengthAdjustment: number;
  private isXmlMode: boolean = false;

  /**
   * Creates a new LengthBasedSplitter
   * @param options Configuration options
   */
  constructor(options: LengthBasedSplitterOptions = {}) {
    super();
    this.buffer = Buffer.alloc(0);
    this.littleEndian = options.littleEndian ?? false;
    this.maxFrameLength = options.maxFrameLength ?? DEFAULT_MAX_FRAME_LENGTH;
    this.lengthFieldOffset =
      options.lengthFieldOffset ?? DEFAULT_LENGTH_FIELD_OFFSET;
    this.lengthFieldLength =
      options.lengthFieldLength ?? DEFAULT_LENGTH_FIELD_LENGTH;
    this.lengthAdjustment =
      options.lengthAdjustment ?? DEFAULT_LENGTH_ADJUSTMENT;

    // If readableStream is provided, pipe it to this
    if (options.readableStream) {
      options.readableStream.pipe(this);
    }
  }

  /**
   * Shutdown the splitter and remove all listeners
   */
  shutdown(): void {
    // Reset internal state
    this.buffer = Buffer.alloc(0);
    this.isXmlMode = false;

    // Remove all listeners
    this.removeAllListeners();
    log.debug('LengthBasedSplitter shutdown complete');
  }

  _transform(
    chunk: Buffer,
    encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    try {
      // Add the new chunk to our buffer
      this.buffer = Buffer.concat([this.buffer, chunk]);

      // Check if this is XML data or binary plist before doing any other processing
      const bufferString = this.buffer.toString(
        UTF8_ENCODING,
        0,
        Math.min(MAX_PREVIEW_LENGTH, this.buffer.length),
      );

      // Check for XML format
      if (isXmlPlistContent(bufferString) || this.isXmlMode) {
        // This is XML data, set XML mode
        this.isXmlMode = true;
        this.processXmlData(callback);
        return;
      }

      // Check for binary plist format (bplist00 or Ibplist00)
      if (this.buffer.length >= BINARY_PLIST_HEADER_LENGTH) {
        const possibleBplistHeader = this.buffer.toString(
          UTF8_ENCODING,
          0,
          BINARY_PLIST_HEADER_LENGTH,
        );

        if (
          possibleBplistHeader === BINARY_PLIST_MAGIC ||
          possibleBplistHeader.includes(BINARY_PLIST_MAGIC)
        ) {
          log.debug('Detected standard binary plist format');
          this.push(this.buffer);
          this.buffer = Buffer.alloc(0);
          return callback();
        }

        if (
          possibleBplistHeader === IBINARY_PLIST_MAGIC ||
          possibleBplistHeader.includes(IBINARY_PLIST_MAGIC)
        ) {
          log.debug('Detected non-standard Ibplist00 format');
          this.push(this.buffer);
          this.buffer = Buffer.alloc(0);
          return callback();
        }
      }
      // Process as many complete messages as possible for binary data
      this.processBinaryData(callback);
    } catch (err) {
      callback(err as Error);
    }
  }

  /**
   * Process data as XML
   */
  private processXmlData(callback: TransformCallback): void {
    const fullBufferString = this.buffer.toString(UTF8_ENCODING);

    let startIndex = 0;
    if (!fullBufferString.startsWith(XML_DECLARATION)) {
      const declIndex = fullBufferString.indexOf(XML_DECLARATION);
      if (declIndex >= 0) {
        startIndex = declIndex;
      } else {
        return callback();
      }
    }

    // Now search for the closing tag in the string starting at startIndex.
    const plistEndIndex = fullBufferString.indexOf(
      PLIST_CLOSING_TAG,
      startIndex,
    );

    if (plistEndIndex >= 0) {
      const endPos = plistEndIndex + PLIST_CLOSING_TAG.length;

      const xmlData = this.buffer.slice(0, endPos);

      // Push the complete XML document downstream.
      this.push(xmlData);

      // Remove the processed data from the buffer.
      this.buffer = this.buffer.slice(endPos);

      // If there's remaining data, check if it still looks XML.
      if (this.buffer.length === 0) {
        this.isXmlMode = false;
      } else {
        const remainingData = this.buffer.toString(
          UTF8_ENCODING,
          0,
          Math.min(MAX_PREVIEW_LENGTH, this.buffer.length),
        );

        this.isXmlMode = isXmlPlistContent(remainingData);
      }
    }

    callback();
  }

  /**
   * Process data as binary with length prefix
   */
  private processBinaryData(callback: TransformCallback): void {
    while (
      this.buffer.length >=
      this.lengthFieldOffset + this.lengthFieldLength
    ) {
      let messageLength: number;

      // Read the length prefix according to configuration
      if (this.lengthFieldLength === LENGTH_FIELD_4_BYTES) {
        messageLength = this.littleEndian
          ? this.buffer.readUInt32LE(this.lengthFieldOffset)
          : this.buffer.readUInt32BE(this.lengthFieldOffset);
      } else if (this.lengthFieldLength === LENGTH_FIELD_2_BYTES) {
        messageLength = this.littleEndian
          ? this.buffer.readUInt16LE(this.lengthFieldOffset)
          : this.buffer.readUInt16BE(this.lengthFieldOffset);
      } else if (this.lengthFieldLength === LENGTH_FIELD_1_BYTE) {
        messageLength = this.buffer.readUInt8(this.lengthFieldOffset);
      } else if (this.lengthFieldLength === LENGTH_FIELD_8_BYTES) {
        const high = this.littleEndian
          ? this.buffer.readUInt32LE(
              this.lengthFieldOffset + LENGTH_FIELD_4_BYTES,
            )
          : this.buffer.readUInt32BE(this.lengthFieldOffset);
        const low = this.littleEndian
          ? this.buffer.readUInt32LE(this.lengthFieldOffset)
          : this.buffer.readUInt32BE(
              this.lengthFieldOffset + LENGTH_FIELD_4_BYTES,
            );
        messageLength = high * UINT32_HIGH_MULTIPLIER + low;
      } else {
        throw new Error(
          `Unsupported lengthFieldLength: ${this.lengthFieldLength}`,
        );
      }

      // Apply adjustment
      messageLength += this.lengthAdjustment;

      // Check if the extracted message length seems suspicious
      if (messageLength < 0 || messageLength > this.maxFrameLength) {
        let alternateLength: number;
        if (this.lengthFieldLength === LENGTH_FIELD_4_BYTES) {
          alternateLength = this.littleEndian
            ? this.buffer.readUInt32BE(this.lengthFieldOffset)
            : this.buffer.readUInt32LE(this.lengthFieldOffset);

          if (alternateLength > 0 && alternateLength <= this.maxFrameLength) {
            messageLength = alternateLength;
          } else {
            // If length is still invalid, check if this might actually be XML
            const suspiciousData = this.buffer.toString(
              UTF8_ENCODING,
              0,
              Math.min(MAX_PREVIEW_LENGTH, this.buffer.length),
            );

            if (isXmlPlistContent(suspiciousData)) {
              this.isXmlMode = true;
              // Process as XML on next iteration
              return callback();
            }

            // Invalid length - skip one byte and try again
            this.buffer = this.buffer.slice(1);
            continue;
          }
        } else {
          // For non-4-byte length fields, just use the original approach
          // If length is invalid, check if this might actually be XML
          const suspiciousData = this.buffer.toString(
            UTF8_ENCODING,
            0,
            Math.min(MAX_PREVIEW_LENGTH, this.buffer.length),
          );

          if (isXmlPlistContent(suspiciousData)) {
            this.isXmlMode = true;
            // Process as XML on next iteration
            return callback();
          }

          // Invalid length - skip one byte and try again
          this.buffer = this.buffer.slice(1);
          continue;
        }
      }

      // Total length of frame = lengthFieldOffset + lengthFieldLength + messageLength
      const totalLength =
        this.lengthFieldOffset + this.lengthFieldLength + messageLength;

      // If we don't have the complete message yet, wait for more data
      if (this.buffer.length < totalLength) {
        break;
      }

      // Extract the message
      try {
        // Extract the complete message
        const message = this.buffer.slice(0, totalLength);

        // Check if this message is actually XML
        const messageStart = message.toString(
          UTF8_ENCODING,
          0,
          Math.min(MAX_PREVIEW_LENGTH, message.length),
        );

        if (isXmlPlistContent(messageStart)) {
          // Switch to XML mode
          this.isXmlMode = true;
          return callback();
        }

        // Push the message
        this.push(message);

        // Remove the processed message from the buffer
        this.buffer = this.buffer.slice(totalLength);
      } catch {
        // move forward by 1 byte and try again
        this.buffer = this.buffer.slice(1);
      }
    }
    callback();
  }
}
