import { EventEmitter } from 'node:events';

import { getLogger } from '../../../lib/logger.js';
import type {
  SyslogOptions,
  SyslogService as SyslogServiceInterface,
} from '../../../lib/types.js';
import { type ServiceConnection } from '../../../service-connection.js';
import { BaseService, type Service } from '../base-service.js';
import {
  type SyslogEntry,
  SyslogProtocolParser,
  formatSyslogEntry,
  formatSyslogEntryColored,
} from './syslog-entry-parser.js';

const syslogLog = getLogger('SyslogMessages');
const log = getLogger('Syslog');

const DEFAULT_SYSLOG_REQUEST = {
  Request: 'StartActivity',
  MessageFilter: 65535,
  StreamFlags: 60,
} as const;

/** Delimiter used by syslog_relay text protocol: newline + null byte */
const SYSLOG_LINE_SPLITTER = Buffer.from([0x0a, 0x00]);

/**
 * syslog-service provides functionality to capture and process syslog messages
 * from a remote device using Apple's XPC services.
 */
class SyslogService extends EventEmitter implements SyslogServiceInterface {
  private readonly baseService: BaseService;
  private connection: ServiceConnection | null = null;
  private isCapturing = false;
  private enableVerboseLogging = false;
  private rawDataHandler: ((data: Buffer) => void) | null = null;
  private readonly syslogParser: SyslogProtocolParser;

  /**
   * Creates a new syslog-service instance
   * @param udid Device UDID
   */
  constructor(private readonly udid: string) {
    super();
    this.baseService = new BaseService(udid);
    this.syslogParser = new SyslogProtocolParser(
      (entry: SyslogEntry) => this.handleSyslogEntry(entry),
      (error: Error) => log.debug(`Syslog parse error: ${error.message}`),
    );
  }

  /**
   * Starts capturing syslog data from the device
   * @param service Service information
   * @param options Configuration options for syslog capture
   */
  async start(service: Service, options: SyslogOptions = {}): Promise<void> {
    if (this.isCapturing) {
      log.info(
        'Syslog capture already in progress. Stopping previous capture.',
      );
      await this.stop();
    }

    const {
      pid = -1,
      enableVerboseLogging = false,
      textMode = false,
    } = options;
    this.enableVerboseLogging = enableVerboseLogging;
    this.isCapturing = true;

    try {
      this.connection = await this.baseService.startLockdownService(
        service.serviceName,
      );

      const socket = this.connection.getSocket();

      if (textMode) {
        // syslog_relay.shim.remote: after RSDCheckin the device immediately
        // streams \n\x00-delimited plain-text log lines. No further request.
        socket.unpipe();
        let textBuf = Buffer.alloc(0);
        this.rawDataHandler = (data: Buffer) => {
          if (!this.isCapturing) {
            return;
          }
          textBuf = Buffer.concat([textBuf, data]);
          let idx: number;
          while ((idx = textBuf.indexOf(SYSLOG_LINE_SPLITTER)) !== -1) {
            const line = textBuf.subarray(0, idx).toString('utf8').trim();
            textBuf = textBuf.subarray(idx + SYSLOG_LINE_SPLITTER.length);
            if (line.length > 0) {
              this.emit('message', line);
            }
          }
        };
        socket.on('data', this.rawDataHandler);
        socket.resume();
        log.info('Syslog text-relay capture started');
        return;
      }

      const request = {
        ...DEFAULT_SYSLOG_REQUEST,
        Pid: pid,
      };

      const response = await this.connection.sendPlistRequest(request);
      if (
        response.Status !== undefined &&
        response.Status !== 'RequestSuccessful'
      ) {
        throw new Error(`StartActivity failed: ${JSON.stringify(response)}`);
      }

      socket.unpipe();
      this.rawDataHandler = (data: Buffer) => {
        if (!this.isCapturing) {
          return;
        }
        this.syslogParser.addData(data);
      };
      socket.on('data', this.rawDataHandler);
      socket.resume();

      log.info(`Syslog capture started: ${JSON.stringify(response)}`);
      this.emit('start', response);
    } catch (error) {
      this.isCapturing = false;
      throw error;
    }
  }

  /**
   * Stops capturing syslog data
   */
  async stop(): Promise<void> {
    if (!this.isCapturing) {
      log.info('No syslog capture in progress.');
      return;
    }

    if (this.rawDataHandler && this.connection) {
      this.connection.getSocket().removeListener('data', this.rawDataHandler);
      this.rawDataHandler = null;
    }

    this.closeConnection();
    this.syslogParser.reset();

    this.isCapturing = false;
    log.info('Syslog capture stopped');
    this.emit('stop');
  }

  /**
   * Restart the device
   * @param service Service information
   */
  async restart(service: Service): Promise<void> {
    try {
      const conn = await this.baseService.startLockdownService(
        service.serviceName,
      );
      const request = { Request: 'Restart' };
      const res = await conn.sendPlistRequest(request);
      log.info(`Restart response: ${res}`);
    } catch (error) {
      log.error(`Error during restart: ${error}`);
      throw error;
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
}

export default SyslogService;
