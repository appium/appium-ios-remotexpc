import { logger } from '@appium/support';

import type { PlistDictionary } from '../../../lib/types.js';
import type { MessageAux } from './dtx-message.js';
import type { DVTSecureSocketProxyService } from './index.js';

const log = logger.getLogger('DVTChannel');

/**
 * Represents a DTX channel for communication
 * Based on pymobiledevice3's Channel class
 */
export class Channel {
  private readonly channelCode: number;
  private readonly service: DVTSecureSocketProxyService;

  constructor(channelCode: number, service: DVTSecureSocketProxyService) {
    this.channelCode = channelCode;
    this.service = service;
  }

  /**
   * Get the channel code
   */
  getChannelCode(): number {
    return this.channelCode;
  }

  /**
   * Receive a plist response from the channel
   * @returns The decoded plist response
   */
  async receivePlist(): Promise<any> {
    const [data, _aux] = await this.service.recvPlist(this.channelCode);
    return data;
  }

  /**
   * Receive both plist response and auxiliary data
   * @returns Tuple of [response, auxiliary]
   */
  async receiveKeyValue(): Promise<[any, any[]]> {
    return this.service.recvPlist(this.channelCode);
  }

  /**
   * Receive raw message data
   * @returns Tuple of [data, auxiliary]
   */
  async receiveMessage(): Promise<[Buffer | null, any[]]> {
    return this.service.recvMessage(this.channelCode);
  }

  /**
   * Send a message on this channel
   * @param selector The method selector
   * @param args Optional message auxiliary arguments
   * @param expectsReply Whether to expect a reply
   */
  async sendMessage(selector: string, args?: MessageAux, expectsReply: boolean = true): Promise<void> {
    await this.service.sendMessage(this.channelCode, selector, args, expectsReply);
  }

  /**
   * Call a method on this channel (similar to Python's __getattr__)
   * This allows calling methods like channel.someMethod(args)
   * @param methodName The method name (will be converted to ObjectiveC format)
   * @returns A function that sends the message
   */
  call(methodName: string): (args?: MessageAux, expectsReply?: boolean) => Promise<void> {
    // Convert Python-style method names to ObjectiveC selectors
    // e.g., "set_location" becomes "setLocation:"
    const selector = this.sanitizeName(methodName);
    
    return async (args?: MessageAux, expectsReply: boolean = true) => {
      await this.sendMessage(selector, args, expectsReply);
    };
  }

  /**
   * Sanitize method name to ObjectiveC selector format
   * Based on pymobiledevice3's _sanitize_name
   */
  private sanitizeName(name: string): string {
    // Handle special case for methods starting with underscore
    if (name.startsWith('_')) {
      // _method_name -> _method:name:
      return '_' + name.substring(1).replace(/_/g, ':');
    } else {
      // method_name -> method:name:
      return name.replace(/_/g, ':');
    }
  }

  /**
   * Helper method for common DVT operations
   * These are convenience methods that wrap the generic call() method
   */
  
  // Start activity
  async start(expectsReply: boolean = false): Promise<void> {
    await this.call('start')(undefined, expectsReply);
  }

  // Stop/clear activity
  async stop(expectsReply: boolean = false): Promise<void> {
    await this.call('stop')(undefined, expectsReply);
  }

  // Clear activity
  async clear(expectsReply: boolean = false): Promise<void> {
    await this.call('clear')(undefined, expectsReply);
  }

  // Set configuration
  async setConfig(config: MessageAux, expectsReply: boolean = false): Promise<void> {
    await this.call('setConfig')(config, expectsReply);
  }
}
