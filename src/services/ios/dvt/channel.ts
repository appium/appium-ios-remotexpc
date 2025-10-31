import { logger } from '@appium/support';

import type { MessageAux } from './dtx-message.js';
import type { DVTSecureSocketProxyService } from './index.js';

const log = logger.getLogger('DVTChannel');

/**
 * Represents a DTX communication channel for a specific service
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
   */
  async receivePlist(): Promise<any> {
    const [data, _aux] = await this.service.recvPlist(this.channelCode);
    return data;
  }

  /**
   * Receive both plist response and auxiliary data
   */
  async receiveKeyValue(): Promise<[any, any[]]> {
    return this.service.recvPlist(this.channelCode);
  }

  /**
   * Receive raw message data
   */
  async receiveMessage(): Promise<[Buffer | null, any[]]> {
    return this.service.recvMessage(this.channelCode);
  }

  /**
   * Send a message on this channel
   * @param selector The ObjectiveC method selector
   * @param args Optional message auxiliary arguments
   * @param expectsReply Whether to expect a reply
   */
  async sendMessage(
    selector: string,
    args?: MessageAux,
    expectsReply: boolean = true,
  ): Promise<void> {
    await this.service.sendMessage(this.channelCode, selector, args, expectsReply);
  }

  /**
   * Call a method on this channel
   * Converts Python-style method names to ObjectiveC selectors
   * @param methodName The method name (e.g., 'setLocation' or 'set_location')
   */
  call(methodName: string): (args?: MessageAux, expectsReply?: boolean) => Promise<void> {
    const selector = this.sanitizeName(methodName);

    return async (args?: MessageAux, expectsReply: boolean = true) => {
      await this.sendMessage(selector, args, expectsReply);
    };
  }

  /**
   * Convert method name to ObjectiveC selector format
   * Examples:
   *   - 'methodName' -> 'methodName'
   *   - 'method_name' -> 'method:name:'
   *   - '_method_name' -> '_method:name:'
   */
  private sanitizeName(name: string): string {
    if (name.startsWith('_')) {
      return '_' + name.substring(1).replace(/_/g, ':');
    }
    return name.replace(/_/g, ':');
  }

  /**
   * Start an activity on this channel
   */
  async start(expectsReply: boolean = false): Promise<void> {
    await this.call('start')(undefined, expectsReply);
  }

  /**
   * Stop an activity on this channel
   */
  async stop(expectsReply: boolean = false): Promise<void> {
    await this.call('stop')(undefined, expectsReply);
  }

  /**
   * Clear an activity on this channel
   */
  async clear(expectsReply: boolean = false): Promise<void> {
    await this.call('clear')(undefined, expectsReply);
  }

  /**
   * Set configuration for this channel
   */
  async setConfig(config: MessageAux, expectsReply: boolean = false): Promise<void> {
    await this.call('setConfig')(config, expectsReply);
  }
}
