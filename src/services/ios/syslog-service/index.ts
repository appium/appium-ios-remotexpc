import { logger } from '@appium/support';
import type { PacketConsumer, PacketData } from 'appium-ios-tuntap';
import { EventEmitter } from 'events';

import { isBinaryPlist } from '../../../lib/plist/binary-plist-parser.js';
import { parsePlist } from '../../../lib/plist/unified-plist-parser.js';
import type {
  PacketSource,
  SyslogOptions,
  SyslogService as SyslogServiceInterface,
} from '../../../lib/types.js';
import { ServiceConnection } from '../../../service-connection.js';
import { BaseService, type Service } from '../base-service.js';

const syslogLog = logger.getLogger('SyslogMessages');
const log = logger.getLogger('Syslog');

const MIN_PRINTABLE_RATIO = 0.5;
const ASCII_PRINTABLE_MIN = 32;
const ASCII_PRINTABLE_MAX = 126;
const NON_PRINTABLE_ASCII_REGEX = /[^\x20-\x7E]/g;
const PLIST_XML_MARKERS = ['<?xml', '<plist'];
const BINARY_PLIST_MARKER = 'bplist';
const BINARY_PLIST_MARKER_ALT = 'Ibplist00';
const MIN_PLIST_SIZE = 8;
const PLIST_HEADER_CHECK_SIZE = 100;

const DEFAULT_SYSLOG_REQUEST = {
  Request: 'StartActivity',
  MessageFilter: 65535,
  StreamFlags: 60,
} as const;

/**
 * syslog-service provides functionality to capture and process syslog messages
 * from a remote device using Apple's XPC services.
 */
class SyslogService extends EventEmitter implements SyslogServiceInterface {
  private readonly baseService: BaseService;
  private connection: ServiceConnection | null = null;
  private packetConsumer: PacketConsumer | null = null;
  private packetStreamPromise: Promise<void> | null = null;
  private isCapturing = false;
  private enableVerboseLogging = false;

  /**
   * Creates a new syslog-service instance
   * @param address Tuple containing [host, port]
   */
  constructor(address: [string, number]) {
    super();
    this.baseService = new BaseService(address);
  }

  /**
   * Starts capturing syslog data from the device
   * @param service Service information
   * @param packetSource Source of packet data (can be PacketConsumer or AsyncIterable)
   * @param options Configuration options for syslog capture
   * @returns Promise resolving to the initial response from the service
   */
  async start(
    service: Service,
    packetSource: PacketSource | AsyncIterable<PacketData>,
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
    this.isCapturing = true;

    this.attachPacketSource(packetSource);

    try {
      this.connection = await this.baseService.startLockdownService(service);

      const request = {
        ...DEFAULT_SYSLOG_REQUEST,
        Pid: pid,
      };

      const response = await this.connection.sendPlistRequest(request);
      log.info(`Syslog capture started: ${response}`);
      this.emit('start', response);
    } catch (error) {
      this.isCapturing = false;
      this.detachPacketSource();
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

    this.detachPacketSource();
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

  private attachPacketSource(
    packetSource: PacketSource | AsyncIterable<PacketData>,
  ): void {
    if (this.isPacketSource(packetSource)) {
      this.packetConsumer = {
        onPacket: (packet: PacketData) => this.processPacket(packet),
      };
      packetSource.addPacketConsumer(this.packetConsumer);
    } else {
      // Store the promise so we can handle it properly
      this.packetStreamPromise = this.processPacketStream(packetSource);

      // Handle any errors from the stream processing
      this.packetStreamPromise.catch((error) => {
        log.error(`Packet stream processing failed: ${error}`);
        this.emit('error', error);
      });
    }
  }

  private isPacketSource(source: unknown): source is PacketSource {
    return (
      typeof source === 'object' &&
      source !== null &&
      'addPacketConsumer' in source &&
      'removePacketConsumer' in source
    );
  }

  private async processPacketStream(
    packetStream: AsyncIterable<PacketData>,
  ): Promise<void> {
    try {
      for await (const packet of packetStream) {
        if (!this.isCapturing) {
          break;
        }
        this.processPacket(packet);
      }
    } catch (error) {
      log.error(`Error processing packet stream: ${error}`);
    }
  }

  private processPacket(packet: PacketData): void {
    if (packet.protocol === 'TCP') {
      this.processTcpPacket(packet);
    } else if (packet.protocol === 'UDP') {
      this.processUdpPacket(packet);
    }
  }

  /**
   * Detaches the packet source
   */
  private detachPacketSource(): void {
    if (this.packetConsumer) {
      this.packetConsumer = null;
    }

    // Cancel the packet stream processing if it's running
    if (this.packetStreamPromise) {
      // Setting isCapturing to false will cause the stream loop to exit
      this.packetStreamPromise = null;
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
   * Processes a TCP packet
   * @param packet TCP packet to process
   */
  private processTcpPacket(packet: PacketData): void {
    try {
      if (this.mightBePlist(packet.payload)) {
        this.processPlistPacket(packet);
      } else {
        this.processTextPacket(packet);
      }
    } catch (error) {
      log.debug(`Error processing packet: ${error}`);
      this.emitTextMessage(packet.payload);
    }

    this.logPacketDetails(packet);
  }

  private processPlistPacket(packet: PacketData): void {
    try {
      const plistData = parsePlist(packet.payload);
      log.debug('Successfully parsed packet as plist');
      this.emit('plist', plistData);

      const message = JSON.stringify(plistData);
      this.emitMessage(message);
    } catch (error) {
      log.debug(`Failed to parse as plist: ${error}`);
      this.processTextPacket(packet);
    }
  }

  private processTextPacket(packet: PacketData): void {
    const message = this.extractPrintableText(packet.payload);
    if (!message.trim()) {
      log.debug('TCP packet contains no printable text, ignoring.');
      return;
    }

    const isMostlyPrintable = this.isMostlyPrintable(packet.payload);
    if (!isMostlyPrintable) {
      log.debug(
        `TCP packet not mostly printable, but contains text: ${message}`,
      );
    }

    this.emitMessage(message);
  }

  private emitTextMessage(buffer: Buffer): void {
    const message = this.extractPrintableText(buffer);
    if (message.trim()) {
      this.emitMessage(message);
    }
  }

  private emitMessage(message: string): void {
    if (this.enableVerboseLogging) {
      syslogLog.info(message);
    }
    this.emit('message', message);
  }

  /**
   * Checks if the buffer might be a plist (XML or binary)
   * @param buffer Buffer to check
   * @returns True if the buffer might be a plist
   */
  private mightBePlist(buffer: Buffer): boolean {
    try {
      if (buffer.length < MIN_PLIST_SIZE) {
        return false;
      }

      // Check for XML plist
      const headerStr = buffer.toString(
        'utf8',
        0,
        Math.min(PLIST_HEADER_CHECK_SIZE, buffer.length),
      );
      if (PLIST_XML_MARKERS.every((marker) => headerStr.includes(marker))) {
        return true;
      }

      // Check for binary plist
      if (isBinaryPlist(buffer)) {
        return true;
      }

      // Check alternative binary plist markers
      const firstNineChars = buffer.toString(
        'ascii',
        0,
        Math.min(9, buffer.length),
      );
      return (
        firstNineChars === BINARY_PLIST_MARKER_ALT ||
        firstNineChars.includes(BINARY_PLIST_MARKER)
      );
    } catch (error) {
      log.debug(`Error checking if buffer is plist: ${error}`);
      return false;
    }
  }

  /**
   * Processes a UDP packet
   * @param packet UDP packet to process
   */
  private processUdpPacket(packet: PacketData): void {
    log.debug(`Received UDP packet (not filtered here): ${packet}`);
  }

  /**
   * Logs packet details for debugging
   * @param packet Packet to log details for
   */
  private logPacketDetails(packet: PacketData): void {
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
