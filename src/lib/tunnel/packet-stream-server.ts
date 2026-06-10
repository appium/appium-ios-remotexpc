import type { PacketConsumer, PacketData } from 'appium-ios-tuntap';
import { EventEmitter } from 'node:events';
import { type Server, type Socket, createServer } from 'node:net';

import { getLogger } from '../logger.js';
import type { PacketSource } from '../types.js';

const log = getLogger('PacketStreamServer');

type TunnelPacketBinding = Pick<
  PacketSource,
  'addPacketConsumer' | 'removePacketConsumer'
>;

/**
 * Server that exposes packet streaming from a tunnel over TCP
 * This allows cross-process access to tunnel packet streams
 */
export class PacketStreamServer extends EventEmitter {
  private server: Server | null = null;
  private readonly clients: Set<Socket> = new Set();
  private packetConsumer: PacketConsumer | null = null;
  private tunnel: TunnelPacketBinding | null = null;
  private attachedToTunnel = false;

  constructor(private readonly port: number) {
    super();
  }

  /**
   * Bind the tunnel whose packet consumer is attached only while TCP clients are connected.
   */
  bindTunnel(tunnel: TunnelPacketBinding): void {
    this.tunnel = tunnel;
    if (this.clients.size > 0) {
      this.attachToTunnel();
    }
  }

  /**
   * Start the packet stream server
   * @throws {Error} If server is already started
   */
  async start(): Promise<void> {
    if (this.server) {
      throw new Error('Server already started');
    }

    this.server = createServer((client) => {
      this.handleClientConnection(client);
    });
    const server = this.server;

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.port, resolve);
    });
    log.info(`Packet stream server listening on port ${this.port}`);
  }

  async stop(): Promise<void> {
    this.detachFromTunnel();

    for (const client of this.clients) {
      client.destroy();
    }
    this.clients.clear();

    if (this.server) {
      const server = this.server;
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.close(() => resolve());
      });
      this.server = null;
    }
  }

  /**
   * Returns the packet consumer used when attached to a tunnel.
   * Prefer {@link bindTunnel} for lifecycle management.
   */
  getPacketConsumer(): PacketConsumer | null {
    return this.packetConsumer;
  }

  /**
   * Handle new client connection
   */
  private handleClientConnection(client: Socket): void {
    log.info(`Client connected from ${client.remoteAddress}`);
    this.clients.add(client);

    if (this.clients.size === 1) {
      this.attachToTunnel();
    }

    const onClientGone = (): void => {
      this.clients.delete(client);
      if (this.clients.size === 0) {
        this.detachFromTunnel();
      }
    };

    client.on('close', () => {
      log.info(`Client disconnected from ${client.remoteAddress}`);
      onClientGone();
    });

    client.on('error', (err) => {
      log.error(`Client error: ${err}`);
      onClientGone();
    });
  }

  private attachToTunnel(): void {
    if (this.attachedToTunnel || !this.tunnel) {
      return;
    }

    if (!this.packetConsumer) {
      this.packetConsumer = this.createPacketConsumer();
    }

    this.tunnel.addPacketConsumer(this.packetConsumer);
    this.attachedToTunnel = true;
    log.debug('Attached packet consumer to tunnel');
  }

  private detachFromTunnel(): void {
    if (!this.attachedToTunnel || !this.tunnel || !this.packetConsumer) {
      return;
    }

    this.tunnel.removePacketConsumer(this.packetConsumer);
    this.attachedToTunnel = false;
    log.debug('Detached packet consumer from tunnel');
  }

  /**
   * Create packet consumer that broadcasts packets to all connected clients
   */
  private createPacketConsumer(): PacketConsumer {
    return {
      onPacket: (packet: PacketData) => {
        void this.broadcastPacket(packet);
      },
    };
  }

  /**
   * Broadcast packet to all connected clients
   */
  private async broadcastPacket(packet: PacketData): Promise<void> {
    try {
      const serialized = JSON.stringify(packet);
      const message = this.createMessage(serialized);

      await Promise.all(
        Array.from(this.clients).map(async (client) => {
          if (!client.writable) {
            this.clients.delete(client);
            return;
          }
          try {
            await this.writeToClient(client, message);
          } catch (err) {
            log.error(`Failed to write to client: ${err}`);
            this.clients.delete(client);
          }
        }),
      );
    } catch (err) {
      log.error(`Failed to broadcast packet: ${err}`);
    }
  }

  /**
   * Promisified wrapper around `socket.write` so callers can use async/await.
   */
  private writeToClient(client: Socket, message: Buffer): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const onWriteComplete = (err?: Error | null): void => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      };
      client.write(message, onWriteComplete);
    });
  }

  /**
   * Create a message buffer with length prefix
   */
  private createMessage(data: string): Buffer {
    const lengthPrefix = data.length.toString().padStart(10, '0');
    return Buffer.concat([Buffer.from(lengthPrefix), Buffer.from(data)]);
  }
}
