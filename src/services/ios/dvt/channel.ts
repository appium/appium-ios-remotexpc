import type { MessageAux } from './dtx-message.js';
import type { DVTSecureSocketProxyService } from './index.js';

/**
 * Represents a DTX communication channel for a specific instrument service
 */
export class Channel {
  private readonly channelCode: number;
  private readonly service: DVTSecureSocketProxyService;

  constructor(channelCode: number, service: DVTSecureSocketProxyService) {
    this.channelCode = channelCode;
    this.service = service;
  }

  /**
   * Receive a plist response from the channel
   */
  async receivePlist(): Promise<any> {
    const [data, _aux] = await this.service.recvPlist(this.channelCode);
    return data;
  }

  /**
   * Call a method on this channel with automatic ObjectiveC selector conversion
   *
   * Converts method names to ObjectiveC selector format:
   * - 'methodName' -> 'methodName'
   * - 'method_name' -> 'method:name:'
   * - '_method_name' -> '_method:name:'
   *
   * @param methodName The method name
   * @returns A function that sends the message with optional arguments
   */
  call(
    methodName: string,
  ): (args?: MessageAux, expectsReply?: boolean) => Promise<void> {
    const selector = this.convertToSelector(methodName);

    return async (args?: MessageAux, expectsReply: boolean = true) => {
      await this.service.sendMessage(
        this.channelCode,
        selector,
        args,
        expectsReply,
      );
    };
  }

  /**
   * Convert method name to ObjectiveC selector format
   */
  private convertToSelector(name: string): string {
    if (name.startsWith('_')) {
      return '_' + name.substring(1).replace(/_/g, ':');
    }
    return name.replace(/_/g, ':');
  }
}
