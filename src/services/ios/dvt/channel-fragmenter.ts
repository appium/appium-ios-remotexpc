import type { DTXMessageHeader } from './dtx-message.js';

/**
 * Handles message fragmentation for DTX channels
 * Assembles fragmented messages and queues complete messages for retrieval
 */
export class ChannelFragmenter {
  private readonly messages: Buffer[] = [];
  private packetData: Buffer = Buffer.alloc(0);
  private streamPacketData: Buffer = Buffer.alloc(0);

  /**
   * Get the next complete message from the queue
   */
  get(): Buffer | null {
    return this.messages.shift() || null;
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
        this.messages.push(this.packetData);
        this.packetData = Buffer.alloc(0);
      }
    } else {
      this.streamPacketData = Buffer.concat([this.streamPacketData, chunk]);

      if (header.fragmentId === header.fragmentCount - 1) {
        this.messages.push(this.streamPacketData);
        this.streamPacketData = Buffer.alloc(0);
      }
    }
  }
}
