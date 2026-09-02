import type {SendMessageOptions} from '../../../lib/types.js';
import type {MessageAux} from './dtx-message.js';

/**
 * Interface for DTX services that can be used with Channel.
 * Both DVTSecureSocketProxyService and DvtTestmanagedProxyService implement this.
 */
export interface DTXServiceProvider {
  recvPlist(channel: number, signal?: AbortSignal): Promise<[any, any[]]>;
  /** Resolves to the message identifier, for correlating the reply. */
  sendMessage(channel: number, selector: string | null, options?: SendMessageOptions): Promise<number>;
  recvReplyPlist(channel: number, identifier: number, signal?: AbortSignal): Promise<[any, any[]]>;
}

/** Sends the message and resolves to its identifier, for {@link Channel.receiveReply}. */
export type ChannelMethodCall = (args?: MessageAux, expectsReply?: boolean) => Promise<number>;

/**
 * Represents a DTX communication channel for a specific instrument service
 */
export class Channel {
  constructor(
    private readonly channelCode: number,
    private readonly service: DTXServiceProvider,
  ) {}

  /**
   * Get the channel code
   */
  getCode(): number {
    return this.channelCode;
  }

  /**
   * Receive a plist response from the channel
   * @param signal Optional AbortSignal for cancellation
   */
  async receivePlist(signal?: AbortSignal): Promise<any> {
    const [data] = await this.service.recvPlist(this.channelCode, signal);
    return data;
  }

  /**
   * Receive the reply to one request, matched on the identifier {@link call}
   * returned. Prefer this over {@link receivePlist} for request/reply, which
   * takes whichever message arrives first and so can pick up a callback, or a
   * reply meant for another caller.
   *
   * @param identifier The value the matching {@link call} resolved to
   * @param signal Optional AbortSignal for cancellation
   */
  async receiveReply(identifier: number, signal?: AbortSignal): Promise<any> {
    const [data] = await this.service.recvReplyPlist(this.channelCode, identifier, signal);
    return data;
  }

  /**
   * Receive a plist response from the channel with auxiliaries
   * @param signal Optional AbortSignal for cancellation
   * @returns Tuple of [selector, auxiliaries]
   */
  async receivePlistWithAux(signal?: AbortSignal): Promise<[string, any[]]> {
    return await this.service.recvPlist(this.channelCode, signal);
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
    return (async (args, expectsReply = true) =>
      await this.service.sendMessage(this.channelCode, selector, {
        args,
        expectsReply,
      })) as ChannelMethodCall;
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
