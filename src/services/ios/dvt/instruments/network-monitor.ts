import { getLogger } from '../../../../lib/logger.js';
import type {
  ConnectionDetectionEvent,
  ConnectionUpdateEvent,
  InterfaceDetectionEvent,
  NetworkAddress,
  NetworkEvent,
} from '../../../../lib/types.js';
import { BaseInstrument } from './base-instrument.js';

const log = getLogger('NetworkMonitor');

type InterfaceDetectionMessage = [number, string];

type ConnectionDetectionMessage = [
  Buffer,
  Buffer,
  number,
  number,
  number,
  number,
  number,
  number,
];

type ConnectionUpdateMessage = [
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

/**
 * Message types for network monitoring events
 */
export const NetworkMessageType = {
  INTERFACE_DETECTION: 0,
  CONNECTION_DETECTION: 1,
  CONNECTION_UPDATE: 2,
} as const;

/**
 * NetworkMonitor provides real-time network activity monitoring on iOS devices.
 *
 * This instrument captures:
 * - Interface detection events (network interfaces coming up)
 * - Connection detection events (new TCP/UDP connections)
 * - Connection update events (traffic statistics updates)
 */
export class NetworkMonitor extends BaseInstrument {
  static readonly IDENTIFIER =
    'com.apple.instruments.server.services.networking';

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
        return null;
    }
  }

  /**
   * Parse interface detection event data
   */
  private parseInterfaceDetection(
    data: InterfaceDetectionMessage,
  ): InterfaceDetectionEvent {
    const [interfaceIndex, name] = data;
    return {
      type: NetworkMessageType.INTERFACE_DETECTION,
      interfaceIndex,
      name,
    };
  }

  /**
   * Parse connection detection event data
   */
  private parseConnectionDetection(
    data: ConnectionDetectionMessage,
  ): ConnectionDetectionEvent {
    const [
      localAddressRaw,
      remoteAddressRaw,
      interfaceIndex,
      pid,
      recvBufferSize,
      recvBufferUsed,
      serialNumber,
      kind,
    ] = data;

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
  private parseConnectionUpdate(
    data: ConnectionUpdateMessage,
  ): ConnectionUpdateEvent {
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
    ] = data;

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
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);

    const len = buf[0];
    const family = buf[1];
    const port = buf.readUInt16BE(2);

    const result: NetworkAddress = { len, family, port, address: '0.0.0.0' };

    if (len === 0x1c) {
      // IPv6: 8 groups of 16-bit hex values
      result.flowInfo = buf.readUInt32LE(4);
      result.address = Array.from({ length: 8 }, (_, i) =>
        buf.readUInt16BE(8 + i * 2).toString(16),
      ).join(':');
      result.scopeId = buf.readUInt32LE(24);
    } else if (len === 0x10) {
      // IPv4: 4 octets as decimal
      result.address = Array.from(buf.subarray(4, 8)).join('.');
    } else {
      log.warn(`Unknown address length: ${len}`);
    }

    return result;
  }
}
