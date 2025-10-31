import { EventEmitter } from 'events';
import { logger } from '@appium/support';

import type { DTXMessageHeader } from './dtx-message.js';

const log = logger.getLogger('ChannelFragmenter');

/**
 * Handles message fragmentation for DTX channels
 * Based on pymobiledevice3's ChannelFragmenter
 */
export class ChannelFragmenter extends EventEmitter {
  private messages: Buffer[] = [];
  private packetData: Buffer = Buffer.alloc(0);
  private streamPacketData: Buffer = Buffer.alloc(0);

  /**
   * Get the next complete message from the queue
   * @returns The next message buffer or null if none available
   */
  get(): Buffer | null {
    return this.messages.shift() || null;
  }

  /**
   * Check if there are messages available
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
    // Handle positive vs negative channel codes
    // Negative channel codes represent stream data
    if (header.channelCode >= 0) {
      // Regular message data
      this.packetData = Buffer.concat([this.packetData, chunk]);
      
      // Check if this is the last fragment
      if (header.fragmentId === header.fragmentCount - 1) {
        // Complete message received
        this.messages.push(this.packetData);
        this.packetData = Buffer.alloc(0);
        
        // Emit event to notify listeners
        this.emit('message', header.channelCode);
        
        log.debug(`Complete message received for channel ${header.channelCode}`);
      }
    } else {
      // Stream data (negative channel code)
      this.streamPacketData = Buffer.concat([this.streamPacketData, chunk]);
      
      // Check if this is the last fragment
      if (header.fragmentId === header.fragmentCount - 1) {
        // Complete stream message received
        this.messages.push(this.streamPacketData);
        this.streamPacketData = Buffer.alloc(0);
        
        // Emit event to notify listeners
        this.emit('message', Math.abs(header.channelCode));
        
        log.debug(`Complete stream message received for channel ${Math.abs(header.channelCode)}`);
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

  /**
   * Get the number of complete messages in the queue
   */
  getMessageCount(): number {
    return this.messages.length;
  }
}
