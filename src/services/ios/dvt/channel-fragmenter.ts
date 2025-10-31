import { EventEmitter } from 'events';

import type { DTXMessageHeader } from './dtx-message.js';

/**
 * Handles message fragmentation for DTX channels
 * Assembles fragmented messages and queues complete messages for retrieval
 */
export class ChannelFragmenter extends EventEmitter {
  private messages: Buffer[] = [];
  private packetData: Buffer = Buffer.alloc(0);
  private streamPacketData: Buffer = Buffer.alloc(0);

  /**
   * Get the next complete message from the queue
   */
  get(): Buffer | null {
    return this.messages.shift() || null;
  }

  /**
   * Check if messages are available
   */
  hasMessages(): boolean {
    return this.messages.length > 0;
  }

  /**
   * Add a message fragment
   * @param header The message header
   * @param chunk The message data chunk
   */
  addFragment(header: DTXMessageHeader, chunk: Buffer): void {
    // Handle positive vs negative channel codes (stream vs regular data)
    if (header.channelCode >= 0) {
      this.packetData = Buffer.concat([this.packetData, chunk]);

      if (header.fragmentId === header.fragmentCount - 1) {
        this.messages.push(this.packetData);
        this.packetData = Buffer.alloc(0);
        this.emit('message', header.channelCode);
      }
    } else {
      this.streamPacketData = Buffer.concat([this.streamPacketData, chunk]);

      if (header.fragmentId === header.fragmentCount - 1) {
        this.messages.push(this.streamPacketData);
        this.streamPacketData = Buffer.alloc(0);
        this.emit('message', Math.abs(header.channelCode));
      }
    }
  }

  /**
   * Clear all pending messages and fragments
   */
  clear(): void {
    this.messages = [];
    this.packetData = Buffer.alloc(0);
    this.streamPacketData = Buffer.alloc(0);
  }
}
