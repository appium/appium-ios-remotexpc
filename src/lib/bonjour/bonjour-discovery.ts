import { logger } from '@appium/support';
import { type ChildProcess, spawn } from 'node:child_process';
import { lookup } from 'node:dns';
import { EventEmitter } from 'node:events';
import { clearTimeout, setTimeout } from 'node:timers';
import { promisify } from 'node:util';

import {
  BONJOUR_DEFAULT_DOMAIN,
  BONJOUR_SERVICE_TYPES,
  BONJOUR_TIMEOUTS,
  DNS_SD_COMMANDS,
  DNS_SD_PATTERNS,
} from './constants.js';

const log = logger.getLogger('BonjourDiscovery');
const dnsLookup = promisify(lookup);

/**
 * Interface for a discovered Bonjour service
 */
export interface BonjourService {
  name: string;
  type: string;
  domain: string;
  hostname?: string;
  port?: number;
  txtRecord?: Record<string, string>;
  interfaceIndex?: number;
}

/**
 * Interface for AppleTV device discovered via Bonjour
 */
export interface AppleTVDevice {
  name: string;
  identifier: string;
  hostname: string;
  ip?: string;
  port: number;
  model: string;
  version: string;
  minVersion: string;
  authTag?: string;
  interfaceIndex?: number;
}

/**
 * Process output handler result
 */
interface ProcessResult {
  success: boolean;
  data?: any;
  error?: Error;
}

/**
 * Handles DNS-SD process management and communication
 */
class DnssdProcessManager {
  private static readonly log = logger.getLogger('DnssdProcessManager');

  /**
   * Execute a DNS-SD command with timeout and result handling
   */
  static async executeCommand<T>(
    args: string[],
    timeoutMs: number,
    outputHandler: (output: string) => T | boolean,
    timeoutMessage: string,
  ): Promise<T> {
    const process = spawn('dns-sd', args);

    try {
      const result = await this.waitForProcessResult(
        process,
        timeoutMs,
        outputHandler,
        timeoutMessage,
      );

      if (!result.success) {
        throw result.error || new Error('Process execution failed');
      }

      return result.data;
    } finally {
      if (!process.killed) {
        process.kill('SIGTERM');
      }
    }
  }

  /**
   * Create a long-running browse process
   */
  static createBrowseProcess(
    serviceType: string,
    domain: string,
  ): ChildProcess {
    return spawn('dns-sd', [DNS_SD_COMMANDS.BROWSE, serviceType, domain]);
  }

  /**
   * Generic method to wait for process result with timeout
   */
  private static async waitForProcessResult<T>(
    process: ChildProcess,
    timeoutMs: number,
    outputHandler: (output: string) => T | boolean,
    timeoutMessage: string,
  ): Promise<ProcessResult> {
    return new Promise((resolve) => {
      let isResolved = false;
      let result: T | undefined;

      const timeout = setTimeout(() => {
        if (!isResolved) {
          isResolved = true;
          resolve({ success: false, error: new Error(timeoutMessage) });
        }
      }, timeoutMs);

      const cleanup = () => {
        clearTimeout(timeout);
        if (!isResolved) {
          isResolved = true;
        }
      };

      process.stdout?.on('data', (data: Buffer) => {
        if (isResolved) {
          return;
        }

        const output = data.toString();
        this.log.debug(`Process output: ${output}`);

        try {
          const handlerResult = outputHandler(output);
          if (handlerResult === true) {
            cleanup();
            resolve({ success: true });
          } else if (handlerResult) {
            result = handlerResult;
            cleanup();
            resolve({ success: true, data: result });
          }
        } catch (error) {
          cleanup();
          resolve({ success: false, error: error as Error });
        }
      });

      process.stderr?.on('data', (data: Buffer) => {
        if (isResolved) {
          return;
        }

        const error = data.toString();
        this.log.error(`Process error: ${error}`);
        cleanup();
        resolve({
          success: false,
          error: new Error(`Process failed: ${error}`),
        });
      });

      process.on('error', (error: Error) => {
        if (isResolved) {
          return;
        }

        this.log.error(`Failed to start process: ${error}`);
        cleanup();
        resolve({ success: false, error });
      });

      process.on('exit', (code: number | null) => {
        if (isResolved) {
          return;
        }

        if (code !== null && code !== 0) {
          this.log.error(`Process exited with error code: ${code}`);
          cleanup();
          resolve({
            success: false,
            error: new Error(`Process exited with code ${code}`),
          });
        }
      });
    });
  }
}

/**
 * Parses DNS-SD command output
 */
class DnssdOutputParser {
  /**
   * Parse browse output and extract service information
   */
  static parseBrowseOutput(
    output: string,
  ): Array<{ action: string; service: BonjourService }> {
    const results: Array<{ action: string; service: BonjourService }> = [];
    const lines = output.split('\n');

    for (const line of lines) {
      if (this.shouldSkipLine(line)) {
        continue;
      }

      const match = line.match(DNS_SD_PATTERNS.BROWSE_LINE);
      if (match) {
        const [, , action, , interfaceIndex, domain, serviceType, name] = match;
        const trimmedName = name.trim();

        const service: BonjourService = {
          name: trimmedName,
          type: serviceType,
          domain,
          interfaceIndex: parseInt(interfaceIndex, 10),
        };

        results.push({ action, service });
      }
    }

    return results;
  }

  /**
   * Parse resolve output and extract service details
   */
  static parseResolveOutput(
    output: string,
    serviceName: string,
    serviceType: string,
    domain: string,
  ): BonjourService | null {
    const lines = output.split('\n');

    for (const line of lines) {
      const reachableMatch = line.match(DNS_SD_PATTERNS.REACHABLE);
      if (reachableMatch) {
        const [, hostname, port, interfaceIndex] = reachableMatch;
        const txtRecord = this.parseTxtRecord(output);

        return {
          name: serviceName,
          type: serviceType,
          domain,
          hostname,
          port: parseInt(port, 10),
          txtRecord,
          interfaceIndex: parseInt(interfaceIndex, 10),
        };
      }
    }

    return null;
  }

  /**
   * Parse TXT record from output
   */
  private static parseTxtRecord(output: string): Record<string, string> {
    const txtRecord: Record<string, string> = {};
    const txtMatch = output.match(DNS_SD_PATTERNS.TXT_RECORD);

    if (txtMatch) {
      const [, identifier, authTag, model, name, ver, minVer] = txtMatch;
      txtRecord.identifier = identifier;
      txtRecord.authTag = authTag;
      txtRecord.model = model;
      txtRecord.name = name;
      txtRecord.ver = ver;
      txtRecord.minVer = minVer;
    }

    return txtRecord;
  }

  /**
   * Check if line should be skipped
   */
  private static shouldSkipLine(line: string): boolean {
    return (
      line.includes('Timestamp') || line.includes('---') || line.trim() === ''
    );
  }
}

/**
 * Handles service resolution and IP address lookup
 */
class ServiceResolver {
  private static readonly log = logger.getLogger('ServiceResolver');

  /**
   * Resolve a specific service to get detailed information
   */
  static async resolveService(
    serviceName: string,
    serviceType: string = BONJOUR_SERVICE_TYPES.APPLE_TV_PAIRING,
    domain: string = BONJOUR_DEFAULT_DOMAIN,
  ): Promise<BonjourService> {
    this.log.info(`Resolving service: ${serviceName}.${serviceType}.${domain}`);

    const service = await DnssdProcessManager.executeCommand(
      [DNS_SD_COMMANDS.RESOLVE, serviceName, serviceType, domain],
      BONJOUR_TIMEOUTS.SERVICE_RESOLUTION,
      (output: string) =>
        DnssdOutputParser.parseResolveOutput(
          output,
          serviceName,
          serviceType,
          domain,
        ),
      `Service resolution timeout for ${serviceName}`,
    );

    if (!service) {
      throw new Error(`Failed to resolve service ${serviceName}`);
    }

    return service;
  }

  /**
   * Resolve hostname to IP address
   */
  static async resolveIPAddress(hostname: string): Promise<string | undefined> {
    try {
      const result = await dnsLookup(hostname, { family: 4 });
      this.log.info(`Resolved ${hostname} to IPv4: ${result.address}`);
      return result.address;
    } catch (error) {
      this.log.warn(`Failed to resolve hostname ${hostname} to IPv4: ${error}`);
      return undefined;
    }
  }
}

/**
 * Converts Bonjour services to Apple TV devices
 */
class AppleTVDeviceConverter {
  private static readonly log = logger.getLogger('AppleTVDeviceConverter');

  /**
   * Convert a resolved Bonjour service to an Apple TV device with IP resolution
   */
  static async convertToAppleTVDeviceWithIP(
    service: BonjourService,
  ): Promise<AppleTVDevice | null> {
    if (!this.isValidService(service)) {
      return null;
    }

    const { txtRecord, hostname, port } = service;
    if (!txtRecord || !this.hasRequiredTxtFields(txtRecord)) {
      this.log.warn(
        `Service ${service.name} missing required TXT record fields`,
      );
      return null;
    }

    if (!hostname || !port) {
      this.log.warn(`Service ${service.name} missing hostname or port`);
      return null;
    }

    const ip = await ServiceResolver.resolveIPAddress(hostname);

    return {
      name: service.name,
      identifier: txtRecord.identifier,
      hostname,
      ip,
      port,
      model: txtRecord.model,
      version: txtRecord.ver,
      minVersion: txtRecord.minVer || '17',
      authTag: txtRecord.authTag,
      interfaceIndex: service.interfaceIndex,
    };
  }

  /**
   * Check if the service has required fields
   */
  private static isValidService(service: BonjourService): boolean {
    return Boolean(service.hostname && service.port && service.txtRecord);
  }

  /**
   * Check if TXT record has required fields
   */
  private static hasRequiredTxtFields(
    txtRecord: Record<string, string>,
  ): boolean {
    return Boolean(txtRecord.identifier && txtRecord.model && txtRecord.ver);
  }
}

/**
 * Main Bonjour discovery service orchestrator
 */
export class BonjourDiscovery extends EventEmitter {
  private browseProcess?: ChildProcess;
  private _isDiscovering = false;
  private readonly discoveredServices: Map<string, BonjourService> = new Map();

  /**
   * Start browsing for Bonjour services
   */
  async startBrowsing(
    serviceType: string = BONJOUR_SERVICE_TYPES.APPLE_TV_PAIRING,
    domain: string = BONJOUR_DEFAULT_DOMAIN,
  ): Promise<void> {
    if (this._isDiscovering) {
      log.warn('Already discovering services');
      return;
    }

    log.info(`Starting Bonjour discovery for ${serviceType}.${domain}`);

    try {
      await this.initializeBrowsing(serviceType, domain);
    } catch (error) {
      this.cleanup();
      throw error;
    }
  }

  /**
   * Stop browsing for services
   */
  stopBrowsing(): void {
    if (this.browseProcess && !this.browseProcess.killed) {
      log.info('Stopping Bonjour discovery');
      this.browseProcess.kill('SIGTERM');
    }
    this.cleanup();
  }

  /**
   * Get all discovered services
   */
  getDiscoveredServices(): BonjourService[] {
    return Array.from(this.discoveredServices.values());
  }

  /**
   * Resolve a specific service to get detailed information
   */
  async resolveService(
    serviceName: string,
    serviceType: string = BONJOUR_SERVICE_TYPES.APPLE_TV_PAIRING,
    domain: string = BONJOUR_DEFAULT_DOMAIN,
  ): Promise<BonjourService> {
    return ServiceResolver.resolveService(serviceName, serviceType, domain);
  }

  /**
   * Discover Apple TV devices with IP address resolution
   */
  async discoverAppleTVDevicesWithIP(
    timeoutMs: number = BONJOUR_TIMEOUTS.DEFAULT_DISCOVERY,
  ): Promise<AppleTVDevice[]> {
    log.info('Starting Apple TV device discovery with IP resolution');

    try {
      await this.startBrowsing();
      await this.waitForDiscovery(timeoutMs);

      const devices = await this.resolveAllServices();
      log.info(
        `Discovered ${devices.length} Apple TV device(s) with IP addresses:`,
        devices,
      );

      return devices;
    } finally {
      this.stopBrowsing();
    }
  }

  /**
   * Initialize a browsing process
   */
  private async initializeBrowsing(
    serviceType: string,
    domain: string,
  ): Promise<void> {
    this._isDiscovering = true;
    this.discoveredServices.clear();

    const browseProcess = DnssdProcessManager.createBrowseProcess(
      serviceType,
      domain,
    );
    this.browseProcess = browseProcess;

    try {
      await DnssdProcessManager.executeCommand(
        [DNS_SD_COMMANDS.BROWSE, serviceType, domain],
        BONJOUR_TIMEOUTS.BROWSE_STARTUP,
        (output: string) => {
          this.processBrowseOutput(output);
          return output.includes(DNS_SD_PATTERNS.STARTING);
        },
        'DNS-SD browse startup timeout',
      );

      this.setupBrowseEventHandlers(browseProcess);
    } catch (error) {
      this._isDiscovering = false;
      throw error;
    }
  }

  /**
   * Setup event handlers for an ongoing browse process
   */
  private setupBrowseEventHandlers(process: ChildProcess): void {
    process.stdout?.on('data', (data: Buffer) => {
      const output = data.toString();
      log.debug(`dns-sd browse output: ${output}`);
      this.processBrowseOutput(output);
    });

    process.stderr?.on('data', (data: Buffer) => {
      const error = data.toString();
      log.error(`dns-sd browse error: ${error}`);
    });

    process.on('exit', (code: number | null) => {
      if (code !== null && code !== 0) {
        log.error(`dns-sd browse process exited with error code: ${code}`);
      }
      this._isDiscovering = false;
    });
  }

  /**
   * Process browse output using the parser
   */
  private processBrowseOutput(output: string): void {
    const results = DnssdOutputParser.parseBrowseOutput(output);

    for (const { action, service } of results) {
      if (action === 'Add') {
        this.discoveredServices.set(service.name, service);
        this.emit('serviceAdded', service);
        log.info(`Discovered service: ${service.name}`);
      } else if (action === 'Rmv') {
        this.discoveredServices.delete(service.name);
        this.emit('serviceRemoved', service.name);
        log.info(`Service removed: ${service.name}`);
      }
    }
  }

  /**
   * Wait for a discovery period
   */
  private async waitForDiscovery(timeoutMs: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, timeoutMs));
  }

  /**
   * Resolve all discovered services
   */
  private async resolveAllServices(): Promise<AppleTVDevice[]> {
    const services = this.getDiscoveredServices();
    log.info(`Found ${services.length} services to resolve`);

    const devices: AppleTVDevice[] = [];

    for (const service of services) {
      try {
        log.info(`Attempting to resolve service: ${service.name}`);
        const resolvedService = await this.resolveService(service.name);
        const device =
          await AppleTVDeviceConverter.convertToAppleTVDeviceWithIP(
            resolvedService,
          );

        if (device) {
          devices.push(device);
        }
      } catch (error) {
        log.warn(`Failed to resolve service ${service.name}: ${error}`);
      }
    }

    return devices;
  }

  /**
   * Cleanup resources
   */
  private cleanup(): void {
    this.browseProcess = undefined;
    this._isDiscovering = false;
  }
}
