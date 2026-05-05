import { EventEmitter } from 'node:events';
import { Server, Socket, createServer } from 'node:net';

import { getLogger } from '../logger.js';
import type {
  DevicePortForwarderEvents,
  DevicePortForwarderOptions,
  UpstreamSocketConnector,
} from './types.js';

const log = getLogger('PortForwarding');

/**
 * A lifecycle-managed local forwarder that proxies local TCP clients to a device port.
 * A fresh upstream socket is created per local client connection.
 */
export class DevicePortForwarder extends EventEmitter {
  private server?: Server;
  private readonly localPort: number;
  private readonly devicePort: number;
  private readonly host: string;
  private readonly primaryConnector: UpstreamSocketConnector;
  private readonly fallbackConnector?: UpstreamSocketConnector;
  private readonly activeSockets = new Set<Socket>();

  constructor(
    localPort: number,
    devicePort: number,
    options: DevicePortForwarderOptions,
  ) {
    super();
    this.localPort = localPort;
    this.devicePort = devicePort;
    this.host = options.host ?? '127.0.0.1';
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
      void this.handleDownstreamConnection(localSocket);
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

  private async handleDownstreamConnection(localSocket: Socket): Promise<void> {
    this.activeSockets.add(localSocket);
    this.emit('clientConnected', localSocket);

    let upstreamSocket: Socket | undefined;
    try {
      upstreamSocket = await this.openUpstreamSocket();
    } catch (err) {
      log.debug(
        `Failed to open upstream socket for device port ${this.devicePort}: ${err}`,
      );
      this.emit('upstreamConnectError', err);
      this.emit('clientDisconnected', localSocket, err);
      localSocket.destroy();
      return;
    }

    this.activeSockets.add(upstreamSocket);
    this.emit('upstreamConnected', upstreamSocket);

    let cleanedUp = false;
    const teardown = (): void => {
      this.activeSockets.delete(localSocket);
      this.activeSockets.delete(upstreamSocket);

      if (cleanedUp) {
        return;
      }
      cleanedUp = true;

      localSocket.unpipe(upstreamSocket);
      upstreamSocket.unpipe(localSocket);
      localSocket.destroy();
      upstreamSocket.destroy();
    };

    let clientError: Error | undefined;
    localSocket.once('error', (err) => {
      clientError = err;
      teardown();
    });
    localSocket.once('close', () => {
      this.emit('clientDisconnected', localSocket, clientError);
      teardown();
    });
    let upstreamError: Error | undefined;
    upstreamSocket.once('error', (err) => {
      upstreamError = err;
      teardown();
    });
    upstreamSocket.once('close', () => {
      this.emit('upstreamDisconnected', upstreamSocket, upstreamError);
      teardown();
    });

    localSocket.pipe(upstreamSocket);
    upstreamSocket.pipe(localSocket);
  }

  private async openUpstreamSocket(): Promise<Socket> {
    try {
      return await this.primaryConnector();
    } catch (primaryError) {
      if (!this.fallbackConnector) {
        throw primaryError;
      }
    }
    return await this.fallbackConnector();
  }
}
