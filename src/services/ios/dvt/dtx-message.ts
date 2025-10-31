import { logger } from '@appium/support';

const log = logger.getLogger('DTXMessage');

/**
 * DTX Message Header structure
 * Based on pymobiledevice3's dtx_message_header_struct
 */
export interface DTXMessageHeader {
  magic: number;
  cb: number;
  fragmentId: number;
  fragmentCount: number;
  length: number;
  identifier: number;
  conversationIndex: number;
  channelCode: number;
  expectsReply: number;
}

/**
 * DTX Message Payload Header structure
 * Based on pymobiledevice3's dtx_message_payload_header_struct
 */
export interface DTXMessagePayloadHeader {
  flags: number;
  auxiliaryLength: number;
  totalLength: bigint;
}

/**
 * Message auxiliary type structure
 */
export interface MessageAuxValue {
  type: number;
  value: any;
}

/**
 * Constants for DTX protocol
 */
export const DTX_CONSTANTS = {
  MESSAGE_HEADER_MAGIC: 0x1f3d5b79,
  MESSAGE_HEADER_SIZE: 32,
  PAYLOAD_HEADER_SIZE: 16,
  MESSAGE_AUX_MAGIC: 0x1f0,
  EMPTY_DICTIONARY: 0xa,
  
  // Message types
  INSTRUMENTS_MESSAGE_TYPE: 2,
  EXPECTS_REPLY_MASK: 0x1000,
  
  // Auxiliary value types
  AUX_TYPE_OBJECT: 2,
  AUX_TYPE_INT32: 3,
  AUX_TYPE_INT64: 6,
} as const;

/**
 * DTX Message class for handling message encoding/decoding
 */
export class DTXMessage {
  /**
   * Parse DTX message header from buffer
   */
  static parseMessageHeader(buffer: Buffer): DTXMessageHeader {
    if (buffer.length < DTX_CONSTANTS.MESSAGE_HEADER_SIZE) {
      throw new Error('Buffer too small for DTX message header');
    }

    return {
      magic: buffer.readUInt32LE(0),
      cb: buffer.readUInt32LE(4),
      fragmentId: buffer.readUInt16LE(8),
      fragmentCount: buffer.readUInt16LE(10),
      length: buffer.readUInt32LE(12),
      identifier: buffer.readUInt32LE(16),
      conversationIndex: buffer.readUInt32LE(20),
      channelCode: buffer.readInt32LE(24),
      expectsReply: buffer.readUInt32LE(28),
    };
  }

  /**
   * Build DTX message header buffer
   */
  static buildMessageHeader(header: DTXMessageHeader): Buffer {
    const buffer = Buffer.alloc(DTX_CONSTANTS.MESSAGE_HEADER_SIZE);
    
    buffer.writeUInt32LE(header.magic, 0);
    buffer.writeUInt32LE(header.cb, 4);
    buffer.writeUInt16LE(header.fragmentId, 8);
    buffer.writeUInt16LE(header.fragmentCount, 10);
    buffer.writeUInt32LE(header.length, 12);
    buffer.writeUInt32LE(header.identifier, 16);
    buffer.writeUInt32LE(header.conversationIndex, 20);
    buffer.writeInt32LE(header.channelCode, 24);
    buffer.writeUInt32LE(header.expectsReply, 28);
    
    return buffer;
  }

  /**
   * Parse DTX payload header from buffer
   */
  static parsePayloadHeader(buffer: Buffer): DTXMessagePayloadHeader {
    if (buffer.length < DTX_CONSTANTS.PAYLOAD_HEADER_SIZE) {
      throw new Error('Buffer too small for DTX payload header');
    }

    return {
      flags: buffer.readUInt32LE(0),
      auxiliaryLength: buffer.readUInt32LE(4),
      totalLength: buffer.readBigUInt64LE(8),
    };
  }

  /**
   * Build DTX payload header buffer
   */
  static buildPayloadHeader(header: DTXMessagePayloadHeader): Buffer {
    const buffer = Buffer.alloc(DTX_CONSTANTS.PAYLOAD_HEADER_SIZE);
    
    buffer.writeUInt32LE(header.flags, 0);
    buffer.writeUInt32LE(header.auxiliaryLength, 4);
    buffer.writeBigUInt64LE(header.totalLength, 8);
    
    return buffer;
  }
}

/**
 * Message auxiliary builder for DTX protocol
 */
export class MessageAux {
  private values: MessageAuxValue[] = [];

  /**
   * Append a 32-bit integer
   */
  appendInt(value: number): MessageAux {
    this.values.push({ type: DTX_CONSTANTS.AUX_TYPE_INT32, value });
    return this;
  }

  /**
   * Append a 64-bit integer
   */
  appendLong(value: number): MessageAux {
    this.values.push({ type: DTX_CONSTANTS.AUX_TYPE_INT64, value });
    return this;
  }

  /**
   * Append an object (will be encoded as plist)
   */
  appendObj(value: any): MessageAux {
    this.values.push({ type: DTX_CONSTANTS.AUX_TYPE_OBJECT, value });
    return this;
  }

  /**
   * Get the raw values for external encoding
   */
  getValues(): MessageAuxValue[] {
    return this.values;
  }

  /**
   * Build the auxiliary data buffer
   */
  build(): Buffer {
    if (this.values.length === 0) {
      return Buffer.alloc(0);
    }

    const buffers: Buffer[] = [];
    
    // Write magic and aux count
    const header = Buffer.alloc(16);
    header.writeBigUInt64LE(BigInt(DTX_CONSTANTS.MESSAGE_AUX_MAGIC), 0);
    header.writeBigUInt64LE(BigInt(this.values.length), 8);
    buffers.push(header);

    // Write each auxiliary value
    for (const auxValue of this.values) {
      // Write empty dictionary marker
      const emptyDictBuffer = Buffer.alloc(4);
      emptyDictBuffer.writeUInt32LE(DTX_CONSTANTS.EMPTY_DICTIONARY, 0);
      buffers.push(emptyDictBuffer);

      // Write type
      const typeBuffer = Buffer.alloc(4);
      typeBuffer.writeUInt32LE(auxValue.type, 0);
      buffers.push(typeBuffer);

      // Write value based on type
      let valueBuffer: Buffer;
      switch (auxValue.type) {
        case DTX_CONSTANTS.AUX_TYPE_INT32:
          valueBuffer = Buffer.alloc(4);
          valueBuffer.writeUInt32LE(auxValue.value, 0);
          break;
        
        case DTX_CONSTANTS.AUX_TYPE_INT64:
          valueBuffer = Buffer.alloc(8);
          valueBuffer.writeBigUInt64LE(BigInt(auxValue.value), 0);
          break;
        
        case DTX_CONSTANTS.AUX_TYPE_OBJECT:
          // For objects, we expect them to be pre-encoded as Buffer
          if (!(auxValue.value instanceof Buffer)) {
            throw new Error('Object values must be pre-encoded as Buffer');
          }
          valueBuffer = auxValue.value;
          break;
        
        default:
          throw new Error(`Unsupported auxiliary type: ${auxValue.type}`);
      }
      
      buffers.push(valueBuffer);
    }

    return Buffer.concat(buffers);
  }

  /**
   * Parse auxiliary data from buffer
   */
  static parse(buffer: Buffer): MessageAuxValue[] {
    if (buffer.length === 0) {
      return [];
    }

    const values: MessageAuxValue[] = [];
    let offset = 0;

    // Read magic
    const magic = buffer.readBigUInt64LE(offset);
    if (magic !== BigInt(DTX_CONSTANTS.MESSAGE_AUX_MAGIC)) {
      throw new Error(`Invalid auxiliary magic: ${magic}`);
    }
    offset += 8;

    // Read count
    const count = Number(buffer.readBigUInt64LE(offset));
    offset += 8;

    // Read each value
    for (let i = 0; i < count; i++) {
      // Skip empty dictionary marker if present
      const emptyDict = buffer.readUInt32LE(offset);
      offset += 4;
      
      if (emptyDict !== DTX_CONSTANTS.EMPTY_DICTIONARY) {
        // If not empty dictionary, this is the type
        offset -= 4;
      }

      // Read type
      const type = buffer.readUInt32LE(offset);
      offset += 4;

      // Read value based on type
      let value: any;
      switch (type) {
        case DTX_CONSTANTS.AUX_TYPE_INT32:
          value = buffer.readUInt32LE(offset);
          offset += 4;
          break;
        
        case DTX_CONSTANTS.AUX_TYPE_INT64:
          value = Number(buffer.readBigUInt64LE(offset));
          offset += 8;
          break;
        
        case DTX_CONSTANTS.AUX_TYPE_OBJECT:
          // For objects, we need to determine the length
          // This is encoded in the plist data itself
          // For now, we'll need the DVT service to handle this
          throw new Error('Object parsing not implemented yet');
        
        default:
          log.warn(`Unknown auxiliary type: ${type}`);
          break;
      }

      values.push({ type, value });
    }

    return values;
  }
}
