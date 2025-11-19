import type { MessageAux } from './dtx-message.js';
import type { DVTSecureSocketProxyService } from './index.js';

export type ChannelMethodCall = (
  args?: MessageAux,
  expectsReply?: boolean,
) => Promise<void>;

/**
 * Represents a DTX communication channel for a specific instrument service
 */
export class Channel {
  constructor(
    private readonly channelCode: number,
    private readonly service: DVTSecureSocketProxyService,
  ) {}

  /**
   * Receive a plist response from the channel
   */
  async receivePlist(): Promise<any> {
    const [data] = await this.service.recvPlist(this.channelCode);
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
  call(methodName: string): ChannelMethodCall {
    const selector = this.convertToSelector(methodName);
    return (async (args, expectsReply = true) => {
      await this.service.sendMessage(
        this.channelCode,
        selector,
        args,
        expectsReply,
      );
    }) as ChannelMethodCall;
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
