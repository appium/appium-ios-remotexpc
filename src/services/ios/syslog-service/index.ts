import { logger } from '@appium/support';
import { EventEmitter } from 'events';

import { isBinaryPlist } from '../../../lib/plist/binary-plist-parser.js';
import { parsePlist } from '../../../lib/plist/unified-plist-parser.js';
import { ServiceConnection } from '../../../service-connection.js';
import { BaseService, type Service } from '../base-service.js';

const syslogLog = logger.getLogger('SyslogMessages');
const log = logger.getLogger('Syslog');

interface Packet {
  protocol: 'TCP' | 'UDP';
  src: string;
  dst: string;
  sourcePort: number;
  destPort: number;
  payload: Buffer;
}

interface TunnelManager extends EventEmitter {
  on(event: 'data', listener: (packet: Packet) => void): this;
  removeListener(event: 'data', listener: (packet: Packet) => void): this;
}

export interface SyslogOptions {
  pid?: number;
  enableVerboseLogging?: boolean;
}

const MIN_PRINTABLE_RATIO = 0.5;
const ASCII_PRINTABLE_MIN = 32;
const ASCII_PRINTABLE_MAX = 126;
// Regex to match non-printable ASCII characters (anything outside ASCII 32-126 range)
// ASCII 32 = space, ASCII 126 = tilde (~)
const NON_PRINTABLE_ASCII_REGEX = /[^\x20-\x7E]/g;

/**
 * syslog-service provides functionality to capture and process syslog messages
 * from a remote device using Apple's XPC services.
 */
class SyslogService extends EventEmitter {
  private readonly address: [string, number];
  private readonly baseService: BaseService;
  private connection: ServiceConnection | null = null;
  private tunnelManager: TunnelManager | null = null;
  private packetListener: ((packet: Packet) => void) | null = null;
  private isCapturing: boolean = false;
  private enableVerboseLogging: boolean = false;

  /**
   * Creates a new syslog-service instance
   * @param address Tuple containing [host, port]
   */
  constructor(address: [string, number]) {
    super();
    this.address = address;
    this.baseService = new BaseService(address);
  }

  /**
   * Starts capturing syslog data from the device
   * @param service Service information
   * @param tunnelManager tunnel manager to handle data packets
   * @param options Configuration options for syslog capture
   * @returns Promise resolving to the initial response from the service
   */
  async start(
    service: Service,
    tunnelManager: TunnelManager,
    options: SyslogOptions = {},
  ): Promise<void> {
    if (this.isCapturing) {
      log.info(
        'Syslog capture already in progress. Stopping previous capture.',
      );
      await this.stop();
    }

    const { pid = -1, enableVerboseLogging = false } = options;
    this.enableVerboseLogging = enableVerboseLogging;

    this.tunnelManager = tunnelManager;
    this.isCapturing = true;

    this.attachPacketListener(tunnelManager);

    try {
      this.connection = await this.baseService.startLockdownService(service);

      const request = {
        Request: 'StartActivity',
        MessageFilter: 65535,
        Pid: pid,
        StreamFlags: 60,
      };

      const response = await this.connection.sendPlistRequest(request);
      log.info(`Syslog capture started: ${response}`);
      this.emit('start', response);
    } catch (error) {
      this.isCapturing = false;
      if (this.tunnelManager && this.packetListener) {
        this.tunnelManager.removeListener('data', this.packetListener);
        this.packetListener = null;
      }
      throw error;
    }
  }

  /**
   * Stops capturing syslog data
   * @returns Promise that resolves when capture is stopped
   */
  async stop(): Promise<void> {
    if (!this.isCapturing) {
      log.info('No syslog capture in progress.');
      return;
    }

    this.detachPacketListener();
    this.closeConnection();

    this.isCapturing = false;
    log.info('Syslog capture stopped');
    this.emit('stop');
  }

  /**
   * Restart the device
   * @param service Service information
   * @returns Promise that resolves when the restart request is sent
   */
  async restart(service: Service): Promise<void> {
    try {
      const conn = await this.baseService.startLockdownService(service);
      const request = { Request: 'Restart' };
      const res = await conn.sendPlistRequest(request);
      log.info(`Restart response: ${res}`);
    } catch (error) {
      log.error(`Error during restart: ${error}`);
      throw error;
    }
  }

  /**
   * Detaches the packet listener from the tunnel manager
   */
  private detachPacketListener(): void {
    if (this.tunnelManager && this.packetListener) {
      this.tunnelManager.removeListener('data', this.packetListener);
      this.packetListener = null;
    }
  }

  /**
   * Closes the current connection
   */
  private closeConnection(): void {
    if (!this.connection) {
      return;
    }

    try {
      this.connection.close();
    } catch (error) {
      log.debug(`Error closing connection: ${error}`);
    } finally {
      this.connection = null;
    }
  }

  /**
   * Attaches a listener to the tunnel manager to process incoming packets
   * @param tunnelManager Manager handling network packets
   */
  private attachPacketListener(tunnelManager: TunnelManager): void {
    this.packetListener = this.createPacketListener();
    tunnelManager.on('data', this.packetListener);
  }

  /**
   * Creates a packet listener function
   * @returns Packet listener function
   */
  private createPacketListener(): (packet: Packet) => void {
    return (packet: Packet) => {
      if (packet.protocol === 'TCP') {
        this.processTcpPacket(packet);
      } else if (packet.protocol === 'UDP') {
        this.processUdpPacket(packet);
      }
    };
  }

  /**
   * Processes a TCP packet
   * @param packet TCP packet to process
   */
  private processTcpPacket(packet: Packet): void {
    try {
      if (this.mightBePlist(packet.payload)) {
        try {
          const plistData = parsePlist(packet.payload);
          log.debug('Successfully parsed packet as plist');
          this.emit('plist', plistData);

          const message = JSON.stringify(plistData);
          if (this.enableVerboseLogging) {
            syslogLog.info(`Plist: ${message}`);
          }
          this.emit('message', message);
        } catch (error) {
          log.debug(`Failed to parse as plist: ${error}`);
          this.processAsText(packet);
        }
      } else {
        this.processAsText(packet);
      }
    } catch (error) {
      log.debug(`Error processing packet: ${error}`);
      const message = this.extractPrintableText(packet.payload);
      if (message.trim()) {
        if (this.enableVerboseLogging) {
          syslogLog.info(message);
        }
        this.emit('message', message);
      }
    }

    this.logPacketDetails(packet);
  }

  /**
   * Process packet as text
   * @param packet The packet to process
   */
  private processAsText(packet: Packet): void {
    try {
      if (this.isMostlyPrintable(packet.payload)) {
        const message = this.extractPrintableText(packet.payload);
        if (message.trim()) {
          if (this.enableVerboseLogging) {
            syslogLog.info(message);
          }
          this.emit('message', message);
        }
      } else {
        const message = this.extractPrintableText(packet.payload);
        if (message.trim()) {
          log.debug(
            `TCP packet not mostly printable, but contains text: ${message}`,
          );
          this.emit('message', message);
        } else {
          log.debug('TCP packet contains no printable text, ignoring.');
        }
      }
    } catch (error) {
      log.debug(`Error processing packet as text: ${error}`);
      try {
        const message = this.extractPrintableText(packet.payload);
        if (message.trim()) {
          if (this.enableVerboseLogging) {
            syslogLog.info(message);
          }
          this.emit('message', message);
        }
      } catch {
        // If all else fails, just ignore this packet
        log.debug('Failed to extract any text from packet, ignoring.');
      }
    }
  }

  /**
   * Checks if the buffer might be a plist (XML or binary)
   * @param buffer Buffer to check
   * @returns True if the buffer might be a plist
   */
  private mightBePlist(buffer: Buffer): boolean {
    try {
      const str = buffer.toString('utf8', 0, Math.min(100, buffer.length));
      if (str.includes('<?xml') && str.includes('<plist')) {
        return true;
      }

      if (buffer.length >= 8) {
        if (isBinaryPlist(buffer)) {
          return true;
        }

        if (buffer.length >= 9) {
          const firstNineChars = buffer.toString('ascii', 0, 9);
          if (
            firstNineChars === 'Ibplist00' ||
            firstNineChars.includes('bplist')
          ) {
            return true;
          }
        }
      }

      return false;
    } catch (error) {
      log.debug(`Error checking if buffer is plist: ${error}`);
      return false;
    }
  }

  /**
   * Processes a UDP packet
   * @param packet UDP packet to process
   */
  private processUdpPacket(packet: Packet): void {
    log.debug(`Received UDP packet (not filtered here): ${packet}`);
  }

  /**
   * Logs packet details for debugging
   * @param packet Packet to log details for
   */
  private logPacketDetails(packet: Packet): void {
    log.debug('Received syslog-like TCP packet:');
    log.debug(`  Source: ${packet.src}`);
    log.debug(`  Destination: ${packet.dst}`);
    log.debug(`  Source port: ${packet.sourcePort}`);
    log.debug(`  Destination port: ${packet.destPort}`);
    log.debug(`  Payload length: ${packet.payload.length}`);
  }

  /**
   * Extracts printable text from a buffer
   * @param buffer Buffer to extract text from
   * @returns Printable text
   */
  private extractPrintableText(buffer: Buffer): string {
    return buffer.toString().replace(NON_PRINTABLE_ASCII_REGEX, '');
  }

  /**
   * Determines if a buffer contains mostly printable ASCII characters
   * @param buffer Buffer to analyze
   * @returns True if more than 50% of characters are printable ASCII
   */
  private isMostlyPrintable(buffer: Buffer): boolean {
    try {
      const str = buffer.toString('utf8');
      if (!str || str.length === 0) {
        return false;
      }

      const totalLength = str.length;
      const threshold = totalLength * MIN_PRINTABLE_RATIO;
      let printableCount = 0;

      for (let i = 0; i < totalLength; i++) {
        const code = str.charCodeAt(i);
        if (code >= ASCII_PRINTABLE_MIN && code <= ASCII_PRINTABLE_MAX) {
          printableCount++;
          if (printableCount > threshold) {
            return true;
          }
        }
      }

      return printableCount / totalLength > MIN_PRINTABLE_RATIO;
    } catch (error) {
      log.debug(error);
      return false;
    }
  }
}

export default SyslogService;
