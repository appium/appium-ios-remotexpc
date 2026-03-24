import { EventEmitter } from 'node:events';
import { Server, Socket, createServer } from 'node:net';

import { getLogger } from '../logger.js';
import { createUsbmux } from '../usbmux/index.js';

const log = getLogger('PortForwarding');

/**
 * Function signature for opening an upstream device socket.
 */
export type UpstreamSocketConnector = () => Promise<Socket>;

/**
 * Options for {@link DevicePortForwarder}.
 */
export interface DevicePortForwarderOptions {
  /** Host to bind the local forwarding server to. */
  host?: string;
  /** Connection timeout (milliseconds) when opening the upstream socket. */
  connectTimeoutMs?: number;
  /**
   * Primary strategy used to open upstream sockets.
   * Defaults to a usbmux-based connector for the configured udid/device port.
   */
  primaryConnector?: UpstreamSocketConnector;
  /**
   * Optional fallback strategy if primary connection fails.
   * Useful for trying multiple transport strategies.
   */
  fallbackConnector?: UpstreamSocketConnector;
}

export interface DevicePortForwarderEvents {
  started: () => void;
  stopped: () => void;
  clientConnected: (socket: Socket) => void;
  clientDisconnected: (socket: Socket) => void;
  upstreamConnected: (socket: Socket) => void;
  upstreamDisconnected: (socket: Socket) => void;
  upstreamConnectError: (error: unknown) => void;
  error: (error: unknown) => void;
}

/**
 * A lifecycle-managed local forwarder that proxies local TCP clients to a device port.
 * A fresh upstream socket is created per local client connection.
 */
export class DevicePortForwarder extends EventEmitter {
  private server?: Server;
  private readonly localPort: number;
  private readonly devicePort: number;
  private readonly udid: string;
  private readonly host: string;
  private readonly connectTimeoutMs: number;
  private readonly primaryConnector?: UpstreamSocketConnector;
  private readonly fallbackConnector?: UpstreamSocketConnector;
  private readonly activeSockets = new Set<Socket>();

  constructor(
    udid: string,
    localPort: number,
    devicePort: number,
    options: DevicePortForwarderOptions = {},
  ) {
    super();
    this.udid = udid;
    this.localPort = localPort;
    this.devicePort = devicePort;
    this.host = options.host ?? '127.0.0.1';
    this.connectTimeoutMs = options.connectTimeoutMs ?? 5000;
    this.primaryConnector = options.primaryConnector;
    this.fallbackConnector = options.fallbackConnector;
  }

  /**
   * Starts the local forwarding server.
   */
  async start(): Promise<void> {
    if (this.server) {
      return;
    }

    this.server = createServer((localSocket: Socket) => {
      void this.handleLocalConnection(localSocket);
    });

    await new Promise<void>((resolve, reject) => {
      this.server?.once('error', reject);
      this.server?.listen(this.localPort, this.host, resolve);
    });
    this.emit('started');
  }

  /**
   * Stops the forwarding server and closes active sockets.
   */
  async stop(): Promise<void> {
    const sockets = Array.from(this.activeSockets);
    this.activeSockets.clear();
    for (const socket of sockets) {
      socket.destroy();
    }

    if (!this.server) {
      return;
    }

    const serverToClose = this.server;
    this.server = undefined;
    await new Promise<void>((resolve, reject) => {
      serverToClose.close((err?: Error) => (err ? reject(err) : resolve()));
    });
    this.emit('stopped');
  }

  override on<K extends keyof DevicePortForwarderEvents>(
    eventName: K,
    listener: DevicePortForwarderEvents[K],
  ): this {
    return super.on(
      eventName,
      listener as (...args: unknown[]) => void,
    ) as this;
  }

  override once<K extends keyof DevicePortForwarderEvents>(
    eventName: K,
    listener: DevicePortForwarderEvents[K],
  ): this {
    return super.once(
      eventName,
      listener as (...args: unknown[]) => void,
    ) as this;
  }

  override off<K extends keyof DevicePortForwarderEvents>(
    eventName: K,
    listener: DevicePortForwarderEvents[K],
  ): this {
    return super.off(
      eventName,
      listener as (...args: unknown[]) => void,
    ) as this;
  }

  private async handleLocalConnection(localSocket: Socket): Promise<void> {
    this.activeSockets.add(localSocket);
    this.emit('clientConnected', localSocket);
    localSocket.once('close', () => {
      this.activeSockets.delete(localSocket);
      this.emit('clientDisconnected', localSocket);
    });

    let upstreamSocket: Socket | undefined;
    try {
      upstreamSocket = await this.openUpstreamSocket();
    } catch (err) {
      log.debug(
        `Failed to open upstream socket for ${this.udid}:${this.devicePort}: ${err}`,
      );
      this.emit('upstreamConnectError', err);
      this.emit('error', err);
      localSocket.destroy();
      return;
    }

    this.activeSockets.add(upstreamSocket);
    this.emit('upstreamConnected', upstreamSocket);

    let cleanedUp = false;
    const teardown = (): void => {
      if (cleanedUp) {
        return;
      }
      cleanedUp = true;
      localSocket.unpipe(upstreamSocket);
      upstreamSocket.unpipe(localSocket);
      localSocket.destroy();
      upstreamSocket.destroy();
      this.activeSockets.delete(localSocket);
      this.activeSockets.delete(upstreamSocket);
      this.emit('upstreamDisconnected', upstreamSocket);
    };

    localSocket.once('close', teardown);
    localSocket.once('error', teardown);
    upstreamSocket.once('close', teardown);
    upstreamSocket.once('error', teardown);

    localSocket.pipe(upstreamSocket);
    upstreamSocket.pipe(localSocket);
  }

  private async openUpstreamSocket(): Promise<Socket> {
    if (this.primaryConnector) {
      try {
        return await this.primaryConnector();
      } catch (primaryError) {
        if (!this.fallbackConnector) {
          throw primaryError;
        }
      }
      return await this.fallbackConnector();
    }
    return await this.connectViaUsbmux();
  }

  private async connectViaUsbmux(): Promise<Socket> {
    const usbmux = await createUsbmux();
    let remoteSocket: Socket | undefined;
    try {
      const device = await usbmux.findDevice(this.udid, this.connectTimeoutMs);
      if (!device) {
        throw new Error(`Device with UDID ${this.udid} not found`);
      }
      remoteSocket = await usbmux.connect(
        device.DeviceID,
        this.devicePort,
        this.connectTimeoutMs,
      );
      return remoteSocket;
    } catch (err) {
      if (!remoteSocket) {
        await usbmux.close().catch(() => {});
      }
      throw err;
    }
  }
}
