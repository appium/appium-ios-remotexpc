import type { PacketConsumer, PacketData } from 'appium-ios-tuntap';
import { EventEmitter } from 'events';

import { getLogger } from '../../../lib/logger.js';
import { isBinaryPlist } from '../../../lib/plist/binary-plist-parser.js';
import { parsePlist } from '../../../lib/plist/unified-plist-parser.js';
import type {
  PacketSource,
  SyslogOptions,
  SyslogService as SyslogServiceInterface,
} from '../../../lib/types.js';
import { ServiceConnection } from '../../../service-connection.js';
import { BaseService, type Service } from '../base-service.js';
import {
  type SyslogEntry,
  SyslogProtocolParser,
  formatSyslogEntry,
  formatSyslogEntryColored,
} from './syslog-entry-parser.js';

const syslogLog = getLogger('SyslogMessages');
const log = getLogger('Syslog');

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
  private readonly syslogParser: SyslogProtocolParser;

  /**
   * Creates a new syslog-service instance
   * @param address Tuple containing [host, port]
   */
  constructor(address: [string, number]) {
    super();
    this.baseService = new BaseService(address);
    this.syslogParser = new SyslogProtocolParser(
      (entry: SyslogEntry) => this.handleSyslogEntry(entry),
      (error: Error) => log.debug(`Syslog parse error: ${error.message}`),
    );
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
    this.syslogParser.reset();

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
   * Processes a TCP packet by detecting plist responses or
   * feeding binary syslog data into the protocol parser.
   */
  private processTcpPacket(packet: PacketData): void {
    try {
      if (this.mightBePlist(packet.payload)) {
        this.processPlistPacket(packet);
      } else {
        this.syslogParser.addData(packet.payload);
      }
    } catch (error) {
      log.debug(`Error processing packet: ${error}`);
    }

    this.logPacketDetails(packet);
  }

  private processPlistPacket(packet: PacketData): void {
    try {
      const plistData = parsePlist(packet.payload);
      log.debug('Successfully parsed packet as plist');
      this.emit('plist', plistData);

      const message = JSON.stringify(plistData);
      this.emit('message', message);
    } catch (error) {
      log.debug(`Failed to parse as plist, feeding to syslog parser: ${error}`);
      this.syslogParser.addData(packet.payload);
    }
  }

  /**
   * Handles a parsed syslog entry by formatting it and emitting events.
   * Terminal output uses colored formatting for readability.
   * The 'message' event emits a plain (uncolored) string for programmatic use.
   */
  private handleSyslogEntry(entry: SyslogEntry): void {
    this.emit('syslogEntry', entry);
    const formatted = formatSyslogEntry(entry);

    if (this.enableVerboseLogging) {
      syslogLog.info(formatSyslogEntryColored(entry));
    }

    this.emit('message', formatted);
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

  private processUdpPacket(packet: PacketData): void {
    if (this.enableVerboseLogging) {
      log.debug(
        `Received UDP packet (not used for syslog): ${packet.src}:${packet.sourcePort}`,
      );
    }
  }

  /**
   * Logs packet details for debugging (only visible when verbose logging is enabled)
   */
  private logPacketDetails(packet: PacketData): void {
    if (this.enableVerboseLogging) {
      log.debug(
        `TCP packet: ${packet.src}:${packet.sourcePort} → ${packet.dst}:${packet.destPort} (${packet.payload.length} bytes)`,
      );
    }
  }
}

export default SyslogService;
