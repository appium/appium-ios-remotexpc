import {EventEmitter} from 'node:events';
import net from 'node:net';

import {getLogger} from '../logger.js';
import type {XPCDictionary} from '../types.js';
import {Http2Constants} from './constants.js';
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
  private peerMaxFrameSize: number = Http2Constants.DEFAULT_PEER_MAX_FRAME_SIZE;
  private peerInitialWindowSize: number = Http2Constants.DEFAULT_PEER_WINDOW_SIZE;
  private connectionSendWindow: number = Http2Constants.DEFAULT_PEER_WINDOW_SIZE;
  private streamSendWindows = new Map<number, number>();
  private sendQueue: {streamId: number; payload: Buffer}[] = [];

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

    this.resetConnectionState();
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
      const handshake = new Handshake(socket);
      await handshake.perform();
      for (const [streamId, bytes] of Object.entries(handshake.dataBytesSent)) {
        this.consumeSendWindow(Number(streamId), bytes);
      }
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
    this.sendQueue.push({streamId, payload});
    this.flushPendingSends();
  }

  /**
   * Writes queued payloads as DATA frames no larger than the peer's max frame size
   * or its send windows. Stops at the first blocked payload so ordering holds.
   */
  private flushPendingSends(): void {
    const socket = this.socket;
    while (socket?.writable && this.sendQueue.length > 0) {
      const send = this.sendQueue[0];
      const size = Math.min(
        send.payload.length,
        this.peerMaxFrameSize,
        this.sendWindow(0),
        this.sendWindow(send.streamId),
      );
      if (size <= 0 && send.payload.length > 0) {
        return;
      }
      socket.write(new DataFrame(send.streamId, send.payload.subarray(0, size), []).serialize());
      this.consumeSendWindow(send.streamId, size);
      if (size === send.payload.length) {
        this.sendQueue.shift();
      } else {
        send.payload = send.payload.subarray(size);
      }
    }
  }

  /** Stream 0 is the connection-level window. */
  private sendWindow(streamId: number): number {
    return streamId === 0
      ? this.connectionSendWindow
      : (this.streamSendWindows.get(streamId) ?? this.peerInitialWindowSize);
  }

  private adjustSendWindow(streamId: number, delta: number): void {
    if (streamId === 0) {
      this.connectionSendWindow += delta;
    } else {
      this.streamSendWindows.set(streamId, this.sendWindow(streamId) + delta);
    }
  }

  private consumeSendWindow(streamId: number, bytes: number): void {
    this.adjustSendWindow(0, -bytes);
    this.adjustSendWindow(streamId, -bytes);
  }

  /** A new INITIAL_WINDOW_SIZE shifts every open stream's window by the delta (RFC 7540 §6.9.2). */
  private applyPeerSettings(settings: Record<number, number>): void {
    const maxFrameSize = settings[Http2Constants.SETTINGS_MAX_FRAME_SIZE];
    if (maxFrameSize !== undefined) {
      this.peerMaxFrameSize = maxFrameSize;
    }
    const initialWindowSize = settings[Http2Constants.SETTINGS_INITIAL_WINDOW_SIZE];
    if (initialWindowSize !== undefined) {
      const delta = initialWindowSize - this.peerInitialWindowSize;
      this.peerInitialWindowSize = initialWindowSize;
      for (const [streamId, window] of this.streamSendWindows) {
        this.streamSendWindows.set(streamId, window + delta);
      }
    }
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
      if (frame.type === 'settings') {
        this.applyPeerSettings(frame.settings);
        this.flushPendingSends();
        continue;
      }
      if (frame.type === 'windowUpdate') {
        this.adjustSendWindow(frame.streamId, frame.increment);
        this.flushPendingSends();
        continue;
      }
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
    this.close().catch((error: unknown) => {
      log.debug(`Failed to close a desynced RemoteXPC transport: ${error}`);
    });
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

  private resetConnectionState(): void {
    this.frameParser = new Http2FrameParser();
    this.pendingXpcData.clear();
    this.desynced = false;
    this.peerMaxFrameSize = Http2Constants.DEFAULT_PEER_MAX_FRAME_SIZE;
    this.peerInitialWindowSize = Http2Constants.DEFAULT_PEER_WINDOW_SIZE;
    this.connectionSendWindow = Http2Constants.DEFAULT_PEER_WINDOW_SIZE;
    this.streamSendWindows.clear();
    this.sendQueue = [];
  }
}
