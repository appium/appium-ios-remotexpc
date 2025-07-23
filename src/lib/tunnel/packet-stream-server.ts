import { logger } from '@appium/support';
import type { PacketConsumer, PacketData } from 'appium-ios-tuntap';
import { EventEmitter } from 'events';
import { type Server, type Socket, createServer } from 'net';

const log = logger.getLogger('PacketStreamServer');

/**
 * Interface for serialized packet message
 */
interface SerializedPacketMessage {
  length: string;
  data: string;
}

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

    this.packetConsumer = this.createPacketConsumer();

    return new Promise((resolve, reject) => {
      this.server!.listen(this.port, () => {
        log.info(`Packet stream server listening on port ${this.port}`);
        resolve();
      });

      this.server!.on('error', reject);
    });
  }

  async stop(): Promise<void> {
    for (const client of this.clients) {
      client.destroy();
    }
    this.clients.clear();

    if (this.server) {
      return new Promise((resolve) => {
        this.server?.close(() => {
          this.server = null;
          resolve();
        });
      });
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
        this.broadcastPacket(packet);
      },
    };
  }

  /**
   * Broadcast packet to all connected clients
   */
  private broadcastPacket(packet: PacketData): void {
    try {
      const serialized = JSON.stringify(packet);
      const message = this.createMessage(serialized);

      for (const client of this.clients) {
        if (!client.destroyed) {
          client.write(message, (err) => {
            if (err) {
              log.error(`Failed to write to client: ${err}`);
              this.clients.delete(client);
            }
          });
        }
      }
    } catch (err) {
      log.error(`Failed to broadcast packet: ${err}`);
    }
  }

  /**
   * Create a message buffer with length prefix
   */
  private createMessage(data: string): Buffer {
    const lengthPrefix = data.length.toString().padStart(10, '0');
    return Buffer.concat([Buffer.from(lengthPrefix), Buffer.from(data)]);
  }
}
