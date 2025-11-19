/**
 * DTX Message Header structure
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
 */
export interface DTXMessagePayloadHeader {
  flags: number;
  auxiliaryLength: number;
  totalLength: bigint;
}

/**
 * Message auxiliary value structure
 */
export interface MessageAuxValue {
  type: number;
  value: any;
}

/**
 * DTX Protocol constants
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
 * DTX Message utilities for encoding and decoding protocol messages
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
 * Message auxiliary builder for DTX protocol parameters
 */
export class MessageAux {
  private readonly values: MessageAuxValue[] = [];

  /**
   * Append a 32-bit integer
   */
  appendInt(value: number): MessageAux {
    this.values.push({ type: DTX_CONSTANTS.AUX_TYPE_INT32, value });
    return this;
  }

  /**
   * Append a 64-bit integer (bigint)
   */
  appendLong(value: bigint): MessageAux {
    this.values.push({ type: DTX_CONSTANTS.AUX_TYPE_INT64, value });
    return this;
  }

  /**
   * Append an object (will be archived as NSKeyedArchiver plist)
   */
  appendObj(value: any): MessageAux {
    this.values.push({ type: DTX_CONSTANTS.AUX_TYPE_OBJECT, value });
    return this;
  }

  /**
   * Get raw values for encoding
   */
  getValues(): MessageAuxValue[] {
    return this.values;
  }
}
