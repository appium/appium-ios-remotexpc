import { EventEmitter } from 'node:events';
import net from 'node:net';

import { getLogger } from '../logger.js';
import { DataFrame } from './handshake-frames.js';
import Handshake from './handshake.js';
import {
  Http2FrameParser,
  buildWindowUpdateFrames,
} from './http2-frame-parser.js';
import { decodeMessage } from './xpc-protocol.js';

const log = getLogger('RemoteXpcFramedTransport');

const DEFAULT_SOCKET_CLOSE_TIMEOUT_MS = 1000;
const DEFAULT_SOCKET_END_TIMEOUT_MS = 500;

export interface RemoteXpcFramedTransportConnectOptions {
  timeoutMs: number;
  handshakeDelayMs?: number;
}

/**
 * Shared RemoteXPC transport: owns TCP socket lifecycle, HTTP/2/XPC handshake,
 * DATA frame parsing, window updates, and XPC message reassembly.
 */
export class RemoteXpcFramedTransport extends EventEmitter {
  private readonly address: [string, number];
  private socket: net.Socket | null = null;
  private frameParser = new Http2FrameParser();
  private pendingXpcData = Buffer.alloc(0);
  private connected = false;
  private closing = false;

  constructor(address: [string, number]) {
    super();
    this.address = address;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  async connect(
    options: RemoteXpcFramedTransportConnectOptions,
  ): Promise<void> {
    if (this.connected) {
      return;
    }

    this.resetParsers();
    const socket = net.createConnection({
      host: this.address[0],
      port: this.address[1],
      family: 6,
      noDelay: true,
      keepAlive: true,
    });
    this.socket = socket;
    this.registerSocketHandlers(socket);

    await this.waitForSocketConnect(socket, options.timeoutMs);

    if (options.handshakeDelayMs) {
      await new Promise<void>((resolve) =>
        setTimeout(resolve, options.handshakeDelayMs),
      );
    }

    try {
      await new Handshake(socket).perform();
      this.connected = true;
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  sendDataFrame(payload: Buffer, streamId = 1): void {
    if (!this.socket?.writable) {
      throw new Error('RemoteXPC socket is not writable');
    }
    this.socket.write(new DataFrame(streamId, payload, []).serialize());
  }

  async close(): Promise<void> {
    this.closing = true;
    this.connected = false;

    const socket = this.socket;
    if (!socket) {
      this.closing = false;
      return;
    }

    this.socket = null;
    await this.shutdownSocket(socket);
    this.closing = false;
  }

  private waitForSocketConnect(
    socket: net.Socket,
    timeoutMs: number,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(
          new Error(`RemoteXPC connection timed out after ${timeoutMs}ms`),
        );
      }, timeoutMs);

      const cleanupConnectListeners = (): void => {
        clearTimeout(timeout);
        socket.off('error', onError);
      };

      const onError = (error: Error): void => {
        cleanupConnectListeners();
        reject(error);
      };

      socket.once('error', onError);
      socket.once('connect', () => {
        cleanupConnectListeners();
        resolve();
      });
    });
  }

  private registerSocketHandlers(socket: net.Socket): void {
    socket.on('data', (data: Buffer | string) => {
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data, 'hex');
      this.handleData(chunk);
    });
    socket.on('error', (error: Error) => {
      if (this.closing) {
        return;
      }
      log.error(`RemoteXPC transport error: ${error.message}`);
      this.connected = false;
      this.emit('error', error);
    });
    socket.on('close', () => {
      this.connected = false;
      this.emit('close');
    });
  }

  private handleData(chunk: Buffer): void {
    if (!this.socket) {
      return;
    }

    let frames;
    try {
      frames = this.frameParser.append(chunk);
    } catch (error) {
      this.emit(
        'error',
        error instanceof Error ? error : new Error(String(error)),
      );
      return;
    }

    for (const frame of frames) {
      if (frame.type !== 'data') {
        continue;
      }

      const { streamId, data, bodyLen } = frame.frame;
      for (const windowUpdate of buildWindowUpdateFrames(streamId, bodyLen)) {
        this.socket.write(windowUpdate);
      }
      this.ingestXpcData(data);
    }
  }

  private ingestXpcData(chunk: Buffer): void {
    let pending = Buffer.concat([this.pendingXpcData, chunk]);
    this.pendingXpcData = Buffer.alloc(0);

    while (pending.length > 0) {
      try {
        const { message, bytesConsumed } = decodeMessage(pending);
        pending = pending.subarray(bytesConsumed);
        if (message.body) {
          this.emit('message', message.body);
        }
      } catch {
        this.pendingXpcData = pending;
        return;
      }
    }
  }

  private shutdownSocket(socket: net.Socket): Promise<void> {
    return new Promise<void>((resolve) => {
      let finished = false;
      const finish = (): void => {
        if (finished) {
          return;
        }
        finished = true;
        resolve();
      };

      const closeTimeout = setTimeout(() => {
        log.warn('RemoteXPC socket close timed out, destroying socket');
        socket.destroy();
        finish();
      }, DEFAULT_SOCKET_CLOSE_TIMEOUT_MS);

      socket.once('close', () => {
        clearTimeout(closeTimeout);
        finish();
      });
      socket.on('error', () => {});

      try {
        socket.removeAllListeners('data');
        socket.end(Buffer.alloc(0), () => {
          setTimeout(() => {
            if (!finished && !socket.destroyed) {
              clearTimeout(closeTimeout);
              socket.destroy();
              finish();
            }
          }, DEFAULT_SOCKET_END_TIMEOUT_MS);
        });
      } catch (error) {
        log.error(
          `Unexpected error during RemoteXPC socket close: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        clearTimeout(closeTimeout);
        socket.destroy();
        finish();
      }
    });
  }

  private resetParsers(): void {
    this.frameParser = new Http2FrameParser();
    this.pendingXpcData = Buffer.alloc(0);
  }
}
