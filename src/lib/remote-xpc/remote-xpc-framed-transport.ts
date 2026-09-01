import {EventEmitter} from 'node:events';
import net from 'node:net';

import {getLogger} from '../logger.js';
import type {XPCDictionary} from '../types.js';
import {DataFrame} from './handshake-frames.js';
import Handshake from './handshake.js';
import {Http2FrameParser, buildWindowUpdateFrames} from './http2-frame-parser.js';
import {decodeMessage, probeXpcFraming} from './xpc-protocol.js';

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
  private pendingXpcData = new Map<number, Buffer>();
  private connected = false;
  private closing = false;
  private desynced = false;

  constructor(address: [string, number]) {
    super();
    this.address = address;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  /**
   * The local (host-side) address of the connected socket — i.e. this host's
   * address *on the tunnel*, as the device sees it.
   *
   * Services that ask the device to open a connection back to the host (for
   * example the DisplayService RTP streams) must advertise this rather than a
   * LAN address, since the tunnel is the only route the device can reach.
   * `undefined` before {@link connect} succeeds.
   */
  get localAddress(): string | undefined {
    return this.socket?.localAddress;
  }

  async connect(options: RemoteXpcFramedTransportConnectOptions): Promise<void> {
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
      await new Promise<void>((resolve) => setTimeout(resolve, options.handshakeDelayMs));
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

  private waitForSocketConnect(socket: net.Socket, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new Error(`RemoteXPC connection timed out after ${timeoutMs}ms`));
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

  /**
   * Handlers ignore a socket that has since been replaced by a reconnect; a closing
   * socket outlives `close()`, and its late events would otherwise hit the new one.
   */
  private registerSocketHandlers(socket: net.Socket): void {
    const superseded = (): boolean => this.socket !== null && this.socket !== socket;

    socket.on('data', (data: Buffer | string) => {
      if (superseded()) {
        return;
      }
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data, 'hex');
      this.handleData(chunk);
    });
    socket.on('error', (error: Error) => {
      if (superseded()) {
        return;
      }
      const wasConnected = this.connected;
      this.connected = false;
      if (this.closing || !wasConnected) {
        log.debug(`RemoteXPC transport error outside connected phase: ${error.message}`);
        return;
      }
      log.error(`RemoteXPC transport error: ${error.message}`);
      this.emit('error', error);
    });
    socket.on('close', () => {
      if (superseded()) {
        return;
      }
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
      this.emit('error', error instanceof Error ? error : new Error(String(error)));
      return;
    }

    for (const frame of frames) {
      if (frame.type !== 'data') {
        continue;
      }

      const socket = this.socket;
      if (this.desynced || !socket) {
        return;
      }

      const {streamId, data, bodyLen} = frame.frame;
      for (const windowUpdate of buildWindowUpdateFrames(streamId, bodyLen)) {
        socket.write(windowUpdate);
      }
      this.ingestXpcData(streamId, data);
    }
  }

  /**
   * Reassembles XPC messages for one HTTP/2 stream; streams buffer separately so
   * interleaving cannot fabricate a desync. Framed-but-undecodable messages are
   * skipped, and a retained tail is copied so it cannot pin the parser's buffer.
   */
  private ingestXpcData(streamId: number, chunk: Buffer): void {
    if (this.desynced) {
      return;
    }

    const buffered = this.pendingXpcData.get(streamId);
    let pending = buffered ? Buffer.concat([buffered, chunk]) : chunk;
    this.pendingXpcData.delete(streamId);

    while (pending.length > 0) {
      const framing = probeXpcFraming(pending);
      if (framing.status === 'incomplete') {
        this.pendingXpcData.set(streamId, Buffer.from(pending));
        return;
      }
      if (framing.status === 'desynced') {
        this.handleDesync(framing.reason);
        return;
      }

      const message = pending.subarray(0, framing.byteLength);
      pending = pending.subarray(framing.byteLength);
      this.decodeAndEmit(message);
    }
  }

  /**
   * Latches the whole connection closed: framing alignment is lost and the peer's
   * remaining bytes cannot be trusted on any stream. Teardown starts before the
   * emit so a listener that reconnects synchronously keeps its new socket.
   */
  private handleDesync(reason: string): void {
    this.desynced = true;
    this.connected = false;
    void this.close();
    this.emit('error', new Error(reason));
  }

  /**
   * A message that will not decode is reported on `'decodeError'`, never `'error'`:
   * it is not fatal, the messages behind it still arrive, and an unheard `'error'`
   * would be thrown by Node.
   */
  private decodeAndEmit(message: Buffer): void {
    let body: XPCDictionary | null | undefined;
    try {
      body = decodeMessage(message).message.body;
    } catch (error) {
      this.emit('decodeError', error instanceof Error ? error : new Error(String(error)));
      return;
    }
    if (body) {
      this.emit('message', body);
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
          `Unexpected error during RemoteXPC socket close: ${error instanceof Error ? error.message : String(error)}`,
        );
        clearTimeout(closeTimeout);
        socket.destroy();
        finish();
      }
    });
  }

  private resetParsers(): void {
    this.frameParser = new Http2FrameParser();
    this.pendingXpcData.clear();
    this.desynced = false;
  }
}
