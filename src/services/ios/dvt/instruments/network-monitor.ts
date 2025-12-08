import { getLogger } from '../../../../lib/logger.js';
import type {
  ConnectionDetectionEvent,
  ConnectionUpdateEvent,
  InterfaceDetectionEvent,
  NetworkAddress,
  NetworkEvent,
} from '../../../../lib/types.js';
import type { Channel } from '../channel.js';
import type { DVTSecureSocketProxyService } from '../index.js';

const log = getLogger('NetworkMonitor');

/**
 * Message types for network monitoring events
 */
export const NetworkMessageType = {
  INTERFACE_DETECTION: 0,
  CONNECTION_DETECTION: 1,
  CONNECTION_UPDATE: 2,
} as const;

export type NetworkMessageTypeValue =
  (typeof NetworkMessageType)[keyof typeof NetworkMessageType];

/**
 * NetworkMonitor provides real-time network activity monitoring on iOS devices.
 *
 * This instrument captures:
 * - Interface detection events (network interfaces coming up)
 * - Connection detection events (new TCP/UDP connections)
 * - Connection update events (traffic statistics updates)
 */
export class NetworkMonitor {
  static readonly IDENTIFIER =
    'com.apple.instruments.server.services.networking';

  private channel: Channel | null = null;

  constructor(private readonly dvt: DVTSecureSocketProxyService) {}

  async initialize(): Promise<void> {
    if (!this.channel) {
      this.channel = await this.dvt.makeChannel(NetworkMonitor.IDENTIFIER);
    }
  }

  async start(): Promise<void> {
    await this.initialize();
    await this.channel!.call('startMonitoring')(undefined, false);
  }

  async stop(): Promise<void> {
    if (this.channel) {
      await this.channel.call('stopMonitoring')();
    }
  }

  /**
   * Async generator that yields network events as they occur.
   *
   * The generator automatically starts monitoring when iteration begins
   * and stops when the iteration is terminated (via break, return, or error).
   *
   * @yields NetworkEvent - Interface detection, connection detection, or connection update events
   */
  async *events(): AsyncGenerator<NetworkEvent, void, unknown> {
    await this.start();
    log.debug('network monitoring started');

    try {
      while (true) {
        const message = await this.channel!.receivePlist();

        // Skip null messages
        if (message === null) {
          continue;
        }

        const event = this.parseMessage(message);
        if (event) {
          yield event;
        }
      }
    } finally {
      log.debug('network monitoring stopped');
      await this.stop();
    }
  }

  /**
   * Parse a raw message into a typed NetworkEvent
   */
  private parseMessage(message: unknown): NetworkEvent | null {
    if (!Array.isArray(message) || message.length < 2) {
      log.warn('Invalid message format:', message);
      return null;
    }

    const [messageType, data] = message;

    switch (messageType) {
      case NetworkMessageType.INTERFACE_DETECTION:
        return this.parseInterfaceDetection(data);
      case NetworkMessageType.CONNECTION_DETECTION:
        return this.parseConnectionDetection(data);
      case NetworkMessageType.CONNECTION_UPDATE:
        return this.parseConnectionUpdate(data);
      default:
        log.warn(`Unsupported event type: ${messageType}`);
        return null;
    }
  }

  /**
   * Parse interface detection event data
   */
  private parseInterfaceDetection(data: unknown): InterfaceDetectionEvent {
    const [interfaceIndex, name] = data as [number, string];
    return {
      type: NetworkMessageType.INTERFACE_DETECTION,
      interfaceIndex,
      name,
    };
  }

  /**
   * Parse connection detection event data
   */
  private parseConnectionDetection(data: unknown): ConnectionDetectionEvent {
    const [
      localAddressRaw,
      remoteAddressRaw,
      interfaceIndex,
      pid,
      recvBufferSize,
      recvBufferUsed,
      serialNumber,
      kind,
    ] = data as [
      Buffer,
      Buffer,
      number,
      number,
      number,
      number,
      number,
      number,
    ];

    return {
      type: NetworkMessageType.CONNECTION_DETECTION,
      localAddress: this.parseAddress(localAddressRaw),
      remoteAddress: this.parseAddress(remoteAddressRaw),
      interfaceIndex,
      pid,
      recvBufferSize,
      recvBufferUsed,
      serialNumber,
      kind,
    };
  }

  /**
   * Parse connection update event data
   */
  private parseConnectionUpdate(data: unknown): ConnectionUpdateEvent {
    const [
      rxPackets,
      rxBytes,
      txPackets,
      txBytes,
      rxDups,
      rx000,
      txRetx,
      minRtt,
      avgRtt,
      connectionSerial,
      time,
    ] = data as [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ];

    return {
      type: NetworkMessageType.CONNECTION_UPDATE,
      rxPackets,
      rxBytes,
      txPackets,
      txBytes,
      rxDups,
      rx000,
      txRetx,
      minRtt,
      avgRtt,
      connectionSerial,
      time,
    };
  }

  /**
   * Parse a raw address buffer into a NetworkAddress structure
   *
   * Address structure format (sockaddr):
   * - Byte 0: Length (0x10 for IPv4, 0x1C for IPv6)
   * - Byte 1: Address family (2 = AF_INET, 30 = AF_INET6)
   * - Bytes 2-3: Port (big-endian)
   * - For IPv4 (len=0x10): Bytes 4-7 are the IP address
   * - For IPv6 (len=0x1C): Bytes 4-7 flow info, 8-23 address, 24-27 scope ID
   */
  private parseAddress(raw: Buffer | Uint8Array): NetworkAddress {
    const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);

    const len = buffer.readUInt8(0);
    const family = buffer.readUInt8(1);
    const port = buffer.readUInt16BE(2);

    let address: string;
    let flowInfo: number | undefined;
    let scopeId: number | undefined;

    if (len === 0x1c) {
      // IPv6 (28 bytes)
      flowInfo = buffer.readUInt32LE(4);
      const ipv6Bytes = buffer.subarray(8, 24);
      address = this.formatIPv6(ipv6Bytes);
      scopeId = buffer.readUInt32LE(24);
    } else if (len === 0x10) {
      // IPv4 (16 bytes)
      const ipv4Bytes = buffer.subarray(4, 8);
      address = this.formatIPv4(ipv4Bytes);
    } else {
      // Unknown format, try to interpret as best as possible
      log.warn(`Unknown address length: ${len}`);
      address = '0.0.0.0';
    }

    return {
      len,
      family,
      port,
      address,
      ...(flowInfo !== undefined && { flowInfo }),
      ...(scopeId !== undefined && { scopeId }),
    };
  }

  /**
   * Format IPv4 address bytes as a dotted decimal string
   */
  private formatIPv4(bytes: Buffer): string {
    return `${bytes[0]}.${bytes[1]}.${bytes[2]}.${bytes[3]}`;
  }

  /**
   * Format IPv6 address bytes as a standard IPv6 string
   */
  private formatIPv6(bytes: Buffer): string {
    const groups: string[] = [];
    for (let i = 0; i < 16; i += 2) {
      const value = bytes.readUInt16BE(i);
      groups.push(value.toString(16));
    }

    return groups.join(':');
  }
}
