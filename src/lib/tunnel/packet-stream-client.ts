import { logger } from '@appium/support';
import type { PacketConsumer, PacketData } from 'appium-ios-tuntap';
import { EventEmitter } from 'events';
import { type Socket, createConnection } from 'net';

const log = logger.getLogger('PacketStreamClient');

/**
 * Constants for packet stream protocol
 */
const PACKET_LENGTH_PREFIX_SIZE = 10;

/**
 * Client that connects to a PacketStreamServer to receive packet data
 * Implements the PacketSource interface required by SyslogService
 */
export class PacketStreamClient extends EventEmitter {
  private socket: Socket | null = null;
  private readonly packetConsumers: Set<PacketConsumer> = new Set();
  private buffer: Buffer = Buffer.alloc(0);
  private connected = false;

  constructor(
    private readonly host: string,
    private readonly port: number,
  ) {
    super();
  }

  async connect(): Promise<void> {
    if (this.connected) {
      log.info('Already connected');
      return;
    }

    return new Promise((resolve, reject) => {
      this.socket = createConnection(
        { host: this.host, port: this.port },
        () => {
          log.info(
            `Connected to packet stream server at ${this.host}:${this.port}`,
          );
          this.connected = true;
          resolve();
        },
      );

      this.socket.on('data', (data) => {
        this.handleData(data);
      });

      this.socket.once('close', () => {
        log.info('Disconnected from packet stream server');
        this.connected = false;
        this.emit('close');
      });

      this.socket.on('error', (err) => {
        log.error(`Socket error: ${err}`);
        this.connected = false;
        if (!this.socket) {
          reject(err);
        } else {
          this.emit('error', err);
        }
      });
    });
  }

  isConnected(): boolean {
    return this.connected;
  }

  async disconnect(): Promise<void> {
    if (this.socket && !this.socket.destroyed) {
      this.socket.destroy();
      this.socket = null;
    }
    this.connected = false;
    this.packetConsumers.clear();
  }

  addPacketConsumer(consumer: PacketConsumer): void {
    this.packetConsumers.add(consumer);
  }

  removePacketConsumer(consumer: PacketConsumer): void {
    this.packetConsumers.delete(consumer);
  }

  /**
   * Handle incoming data from the socket
   */
  private handleData(data: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, data]);
    this.processBuffer();
  }

  /**
   * Process buffered data to extract complete messages
   */
  private processBuffer(): void {
    while (this.buffer.length >= PACKET_LENGTH_PREFIX_SIZE) {
      const messageLength = this.extractMessageLength();

      if (messageLength === null) {
        // Invalid length, reset buffer
        this.buffer = Buffer.alloc(0);
        break;
      }

      const totalMessageSize = PACKET_LENGTH_PREFIX_SIZE + messageLength;

      if (this.buffer.length < totalMessageSize) {
        // Wait for more data
        break;
      }

      const messageData = this.buffer.slice(
        PACKET_LENGTH_PREFIX_SIZE,
        totalMessageSize,
      );
      this.buffer = this.buffer.slice(totalMessageSize);

      this.processMessage(messageData);
    }
  }

  /**
   * Extract message length from buffer
   * @returns Message length or null if invalid
   */
  private extractMessageLength(): number | null {
    const lengthStr = this.buffer
      .slice(0, PACKET_LENGTH_PREFIX_SIZE)
      .toString();
    const messageLength = parseInt(lengthStr, 10);

    if (isNaN(messageLength)) {
      log.error('Invalid message length, clearing buffer');
      return null;
    }

    return messageLength;
  }

  /**
   * Process a single message
   */
  private processMessage(messageData: Buffer): void {
    try {
      const packet = this.parsePacket(messageData);
      this.notifyConsumers(packet);
    } catch (err) {
      log.error(`Error processing message: ${err}`);
    }
  }

  /**
   * Parse packet data from message buffer
   */
  private parsePacket(messageData: Buffer): PacketData {
    const packet: PacketData = JSON.parse(messageData.toString());

    // Reconstruct Buffer from JSON
    if (packet.payload && typeof packet.payload === 'object') {
      packet.payload = Buffer.from(packet.payload);
    }

    return packet;
  }

  /**
   * Notify all packet consumers
   */
  private notifyConsumers(packet: PacketData): void {
    for (const consumer of this.packetConsumers) {
      try {
        consumer.onPacket(packet);
      } catch (err) {
        log.error(`Error in packet consumer: ${err}`);
      }
    }
  }
}
