import type {DTXMessageHeader} from './dtx-message.js';

interface QueuedMessage {
  header: DTXMessageHeader;
  data: Buffer;
}

/** Selects a queued message by its header. */
export type MessageFilter = (header: DTXMessageHeader) => boolean;

/**
 * Matches the reply to one request. DTX replies echo the request's identifier
 * with a non-zero conversation index; device-initiated callbacks use index 0.
 */
export function isReplyTo(identifier: number): MessageFilter {
  return (header) => header.conversationIndex > 0 && header.identifier === identifier;
}

/**
 * Handles message fragmentation for DTX channels
 * Assembles fragmented messages and queues complete messages for retrieval
 */
export class ChannelFragmenter {
  private readonly messages: QueuedMessage[] = [];
  private packetData: Buffer = Buffer.alloc(0);
  private streamPacketData: Buffer = Buffer.alloc(0);

  /**
   * Get the next complete message from the queue.
   * @param filter When set, returns the first matching message and leaves
   *   earlier ones queued for other readers
   */
  get(filter?: MessageFilter): Buffer | null {
    const index = filter ? this.messages.findIndex((m) => filter(m.header)) : 0;
    if (index < 0) {
      return null;
    }
    return this.messages.splice(index, 1)[0]?.data ?? null;
  }

  /**
   * Add a message fragment and assemble if complete
   * @param header The message header
   * @param chunk The message data chunk
   */
  addFragment(header: DTXMessageHeader, chunk: Buffer): void {
    // Handle positive vs negative channel codes (regular vs stream data)
    if (header.channelCode >= 0) {
      this.packetData = Buffer.concat([this.packetData, chunk]);

      if (header.fragmentId === header.fragmentCount - 1) {
        this.messages.push({header, data: this.packetData});
        this.packetData = Buffer.alloc(0);
      }
    } else {
      this.streamPacketData = Buffer.concat([this.streamPacketData, chunk]);

      if (header.fragmentId === header.fragmentCount - 1) {
        this.messages.push({header, data: this.streamPacketData});
        this.streamPacketData = Buffer.alloc(0);
      }
    }
  }
}
