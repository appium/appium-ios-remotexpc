import { logger } from '@appium/support';
import { EventEmitter } from 'events';

import { ServiceConnection } from '../../../service-connection.js';
import BaseService, { type Service } from '../base-service.js';

const log = logger.getLogger('Syslog');

// Define interfaces for clarity
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

interface SyslogOptions {
  /** Process ID to filter (-1 for all processes) */
  pid?: number;
}

/**
 * syslog-service provides functionality to capture and process syslog messages
 * from a remote device using Apple's XPC services.
 */
class SyslogService extends EventEmitter {
  private readonly address: [string, number]; // [host, port]
  private readonly baseService: BaseService;
  private connection: ServiceConnection | null = null;
  private tunnelManager: TunnelManager | null = null;
  private packetListener: ((packet: Packet) => void) | null = null;
  private isCapturing: boolean = false;

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

    const { pid = -1 } = options;

    this.tunnelManager = tunnelManager;
    this.isCapturing = true;

    // Attach listener to capture network packets
    this.attachPacketListener(tunnelManager);

    // Connect to the os_trace_relay service
    this.connection = await this.baseService.startLockdownService(service);

    // Start the activity to receive syslog messages
    const request = {
      Request: 'StartActivity',
      MessageFilter: 65535,
      Pid: pid,
      StreamFlags: 60,
    };

    const response = await this.connection.sendPlistRequest(request);
    log.info(`Syslog capture started: ${response}`);
    this.emit('start', response);
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

    // Remove packet listener
    if (this.tunnelManager && this.packetListener) {
      this.tunnelManager.removeListener('data', this.packetListener);
      this.packetListener = null;
    }

    // Close connection
    if (this.connection) {
      try {
        // Simply close the connection without sending StopActivity
        this.connection.close();
        this.connection = null;
      } catch (error) {
        log.debug(`Error closing connection: ${error}`);
        this.connection = null;
      }
    }

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
      // Connect to the diagnostics service for restart.
      const conn = await this.baseService.startLockdownService(service);
      // Create a plist request for restart.
      const request = { Request: 'Restart' };
      // Send the restart request.
      const res = await conn.sendPlistRequest(request);
      log.info(`Restart response: ${res}`);
    } catch (error) {
      log.error(`Error during restart: ${error}`);
    }
  }

  /**
   * Attaches a listener to the tunnel manager to process incoming packets
   * @param tunnelManager Manager handling network packets
   */
  private attachPacketListener(tunnelManager: TunnelManager): void {
    // Create the packet listener function
    this.packetListener = (packet: Packet) => {
      if (packet.protocol === 'TCP') {
        // Filter packets by checking if they contain printable text
        if (this.isMostlyPrintable(packet.payload)) {
          const message = packet.payload
            .toString()
            .replace(/[^\x20-\x7E]/g, '');

          // Log to console
          log.info(`[Syslog] ${message}`);

          // Emit the message event
          this.emit('message', message);

          // Debug logging
          log.debug('Received syslog-like TCP packet:');
          log.debug(`  Source: ${packet.src}`);
          log.debug(`  Destination: ${packet.dst}`);
          log.debug(`  Source port: ${packet.sourcePort}`);
          log.debug(`  Destination port: ${packet.destPort}`);
          log.debug(`  Payload length: ${packet.payload.length}`);
        } else {
          log.debug('TCP packet not mostly printable, ignoring.');
        }
      } else if (packet.protocol === 'UDP') {
        // Process UDP packets if needed
        log.debug(`Received UDP packet (not filtered here): ${packet}`);
      }
    };

    // Attach the listener
    tunnelManager.on('data', this.packetListener);
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

      let printableCount = 0;
      for (let i = 0; i < str.length; i++) {
        const code = str.charCodeAt(i);
        // ASCII printable characters (space through ~)
        if (code >= 32 && code <= 126) {
          printableCount++;
        }
      }

      return printableCount / str.length > 0.5;
    } catch (error) {
      log.debug(error);
      return false;
    }
  }
}

export default SyslogService;
