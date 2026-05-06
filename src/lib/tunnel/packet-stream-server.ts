import type { PacketConsumer, PacketData } from 'appium-ios-tuntap';
import { EventEmitter } from 'node:events';
import { type Server, type Socket, createServer } from 'node:net';

import { getLogger } from '../logger.js';

const log = getLogger('PacketStreamServer');

/**
 * Server that exposes packet streaming from a tunnel over TCP
 * This allows cross-process access to tunnel packet streams
 */
export class PacketStreamServer extends EventEmitter {
  private server: Server | null = null;
  private readonly clients: Set<Socket> = new Set();
  private packetConsumer: PacketConsumer | null = null;

  constructor(private readonly port: number) {
    super();
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

    this.packetConsumer = this.createPacketConsumer();

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.port, resolve);
    });
    log.info(`Packet stream server listening on port ${this.port}`);
  }

  async stop(): Promise<void> {
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

  getPacketConsumer(): PacketConsumer | null {
    return this.packetConsumer;
  }

  /**
   * Handle new client connection
   */
  private handleClientConnection(client: Socket): void {
    log.info(`Client connected from ${client.remoteAddress}`);
    this.clients.add(client);

    client.on('close', () => {
      log.info(`Client disconnected from ${client.remoteAddress}`);
      this.clients.delete(client);
    });

    client.on('error', (err) => {
      log.error(`Client error: ${err}`);
      this.clients.delete(client);
    });
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
          if (client.destroyed) {
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
      client.write(message, (err?: Error | null) =>
        err ? reject(err) : resolve(),
      );
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
