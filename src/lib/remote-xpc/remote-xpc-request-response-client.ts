import type { XPCDictionary } from '../types.js';
import { XpcConstants } from './constants.js';
import { RemoteXpcFramedTransport } from './remote-xpc-framed-transport.js';
import { encodeMessage } from './xpc-protocol.js';

const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
const DEFAULT_RESPONSE_TIMEOUT_MS = 10_000;
const FIRST_APPLICATION_MESSAGE_ID = 1;

interface PendingResponse {
  resolve: (body: XPCDictionary) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * RemoteXPC request/reply client for a concrete service port.
 */
export class RemoteXpcRequestResponseClient {
  private readonly address: [string, number];
  private transport: RemoteXpcFramedTransport | null = null;
  private responseQueue: XPCDictionary[] = [];
  private waiters: PendingResponse[] = [];
  private nextMessageId = FIRST_APPLICATION_MESSAGE_ID;

  constructor(address: [string, number]) {
    this.address = address;
  }

  async connect(timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS): Promise<void> {
    if (this.transport?.isConnected) {
      return;
    }

    const transport = new RemoteXpcFramedTransport(this.address);
    this.registerTransportHandlers(transport);
    await transport.connect({ timeoutMs });
    this.transport = transport;
  }

  async sendReceiveRequest(
    body: XPCDictionary,
    timeoutMs = DEFAULT_RESPONSE_TIMEOUT_MS,
  ): Promise<XPCDictionary> {
    await this.ensureConnected();
    this.sendRequest(body, true);
    return await this.receiveResponse(timeoutMs);
  }

  async close(): Promise<void> {
    this.rejectWaiters(new Error('RemoteXPC service connection closed'));

    if (!this.transport) {
      return;
    }

    const transport = this.transport;
    this.transport = null;
    await transport.close();
  }

  private async ensureConnected(): Promise<void> {
    if (!this.transport?.isConnected) {
      await this.connect();
    }
  }

  private sendRequest(body: XPCDictionary, wantingReply: boolean): void {
    if (!this.transport?.isConnected) {
      throw new Error('RemoteXPC request/reply client is not connected');
    }

    let flags = XpcConstants.XPC_FLAGS_ALWAYS_SET;
    if (Object.keys(body).length > 0) {
      flags |= XpcConstants.XPC_FLAGS_DATA_PRESENT;
    }
    if (wantingReply) {
      flags |= XpcConstants.XPC_FLAGS_WANTING_REPLY;
    }

    const payload = encodeMessage({
      flags,
      id: BigInt(this.nextMessageId),
      body,
    });
    this.nextMessageId += 1;

    this.transport.sendDataFrame(payload);
  }

  private receiveResponse(timeoutMs: number): Promise<XPCDictionary> {
    const queued = this.responseQueue.shift();
    if (queued) {
      return Promise.resolve(queued);
    }

    return new Promise<XPCDictionary>((resolve, reject) => {
      const pending: PendingResponse = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter((waiter) => waiter !== pending);
          reject(
            new Error(
              `Timed out waiting for RemoteXPC response after ${timeoutMs}ms`,
            ),
          );
        }, timeoutMs),
      };
      this.waiters.push(pending);
    });
  }

  private registerTransportHandlers(transport: RemoteXpcFramedTransport): void {
    transport.on('message', (body) => this.enqueueResponse(body));
    transport.on('error', (error) => {
      this.rejectWaiters(error);
    });
    transport.on('close', () =>
      this.rejectWaiters(new Error('RemoteXPC service connection closed')),
    );
  }

  private enqueueResponse(body: XPCDictionary): void {
    const waiter = this.waiters.shift();
    if (!waiter) {
      this.responseQueue.push(body);
      return;
    }

    clearTimeout(waiter.timer);
    waiter.resolve(body);
  }

  private rejectWaiters(error: Error): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }
}
