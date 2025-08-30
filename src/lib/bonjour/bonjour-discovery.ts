import { logger } from '@appium/support';
import { type ChildProcess, spawn } from 'node:child_process';
import { resolve4 } from 'node:dns/promises';
import { EventEmitter } from 'node:events';
import { clearTimeout, setTimeout } from 'node:timers';
import { setTimeout as delay } from 'node:timers/promises';

import {
  BONJOUR_DEFAULT_DOMAIN,
  BONJOUR_SERVICE_TYPES,
  BONJOUR_TIMEOUTS,
  DNS_SD_ACTIONS,
  DNS_SD_COMMANDS,
  DNS_SD_PATTERNS,
} from './constants.js';

const log = logger.getLogger('BonjourDiscovery');

const DNS_SD_COMMAND = 'dns-sd';

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
 * Type alias for service discovery results
 */
export type ServiceDiscoveryResult = Array<{
  action: string;
  service: BonjourService;
}>;

/**
 * Process output handler result
 */
interface ProcessResult {
  success: boolean;
  data?: any;
  error?: Error;
}

/**
 * Execute a dns-sd command with a timeout.
 *
 * @param args Arguments passed to the dns-sd CLI.
 * @param timeoutMs Timeout in milliseconds.
 * @param outputHandler Called for each stdout chunk from dns-sd:
 *   - returns true: chunk handled; no result recorded; continue listening
 *   - returns a truthy non-true value (e.g., object): store as result to return when the process ends
 *   - returns false/undefined/null: ignore; continue listening
 *   - throws: mark command as failed
 * @param timeoutMessage Error message used if the command times out.
 * @returns The value produced by outputHandler, if any, when the process ends.
 */
async function executeDnsSdCommand<T>(
  args: string[],
  timeoutMs: number,
  outputHandler: (output: string) => T | boolean,
  timeoutMessage: string,
): Promise<T> {
  const child = spawn(DNS_SD_COMMAND, args);
  try {
    const result = await waitForProcessResult<T>(
      child,
      timeoutMs,
      outputHandler,
      timeoutMessage,
    );

    if (!result.success) {
      throw result.error || new Error('Process execution failed');
    }
    return result.data as T;
  } finally {
    if (!child.killed) {
      child.kill('SIGTERM');
    }
  }
}

/**
 * Create a long-running browse process
 */
function createDnsSdBrowseProcess(
  serviceType: string,
  domain: string,
): ChildProcess {
  return spawn(DNS_SD_COMMAND, [DNS_SD_COMMANDS.BROWSE, serviceType, domain]);
}

/**
 * Wait for a child process result with a timeout.
 *
 * @param process Child process to observe.
 * @param timeoutMs Timeout in milliseconds.
 * @param outputHandler Called for each stdout chunk from dns-sd:
 *   - returns true: chunk handled; no result recorded; continue listening
 *   - returns a truthy non-true value (e.g., object): store as result to return when the process ends
 *   - returns false/undefined/null: ignore; continue listening
 *   - throws: mark command as failed
 * @param timeoutMessage Error message used if the operation times out.
 * @returns A ProcessResult indicating success and any data from outputHandler.
 */
async function waitForProcessResult<T>(
  process: ChildProcess,
  timeoutMs: number,
  outputHandler: (output: string) => T | boolean,
  timeoutMessage: string,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    let isResolved = false;
    let result: T | undefined;
    let exitCode: number | null = null;
    let hasError = false;
    let errorMessage = '';

    const timeout = setTimeout(() => {
      if (!isResolved) {
        isResolved = true;
        reject(new Error(timeoutMessage));
      }
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timeout);
      if (!isResolved) {
        isResolved = true;

        if (hasError) {
          reject(new Error(errorMessage));
        } else if (exitCode !== null && exitCode !== 0) {
          reject(new Error(`Process exited with code ${exitCode}`));
        } else if (result !== undefined) {
          resolve({ success: true, data: result });
        } else {
          resolve({ success: true });
        }
      }
    };

    process.stdout?.on('data', (data: Buffer) => {
      if (isResolved) {
        return;
      }

      const output = data.toString();
      log.debug(`[dns-sd] output: ${output}`);

      try {
        const handlerResult = outputHandler(output);
        if (handlerResult === true) {
          result = undefined;
        } else if (handlerResult) {
          result = handlerResult as T;
        }
      } catch (error) {
        hasError = true;
        errorMessage = `Output handler error: ${error}`;
      }
    });

    process.stderr?.on('data', (data: Buffer) => {
      if (isResolved) {
        return;
      }

      const error = data.toString();
      log.error(`[dns-sd] error: ${error}`);
      hasError = true;
      errorMessage = `Process failed: ${error}`;
    });

    process.on('error', (error: Error) => {
      if (isResolved) {
        return;
      }

      log.error(`[dns-sd] failed to start process: ${error}`);
      hasError = true;
      errorMessage = `Failed to start process: ${error}`;
    });

    process.on('exit', (code: number | null) => {
      exitCode = code;
      if (code !== null && code !== 0) {
        log.error(`[dns-sd] process exited with error code: ${code}`);
      }
    });
    process.on('close', (code: number | null) => {
      log.debug(`[dns-sd] process closed with code: ${code}`);
      cleanup();
    });
  });
}

/**
 * Parse browse output and extract service information
 */
function parseBrowseOutput(output: string): ServiceDiscoveryResult {
  const reducer = (
    acc: ServiceDiscoveryResult,
    line: string,
  ): ServiceDiscoveryResult => {
    const match = line.match(DNS_SD_PATTERNS.BROWSE_LINE);
    if (!match) {
      return acc;
    }

    const [, , action, , interfaceIndex, domain, serviceType, name] = match;
    const trimmedName = name.trim();

    const service: BonjourService = {
      name: trimmedName,
      type: serviceType,
      domain,
      interfaceIndex: parseInt(interfaceIndex, 10),
    };

    acc.push({ action, service });
    return acc;
  };

  return output
    .split('\n')
    .filter((line) => !shouldSkipLine(line))
    .reduce<ServiceDiscoveryResult>(reducer, []);
}

/**
 * Parse resolve output and extract service details
 */
function parseResolveOutput(
  output: string,
  serviceName: string,
  serviceType: string,
  domain: string,
): BonjourService | null {
  return parseOutput<BonjourService | null>(
    output,
    (line: string, result: BonjourService | null) => {
      // If we already found a result, return it (early termination)
      if (result) {
        return result;
      }

      const reachableMatch = line.match(DNS_SD_PATTERNS.REACHABLE);
      if (reachableMatch) {
        const [, hostname, port, interfaceIndex] = reachableMatch;
        const txtRecord = parseTxtRecord(output);

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
      return result;
    },
    null as BonjourService | null,
  );
}

/**
 * Generic method to parse output with different reducer functions
 */
function parseOutput<T>(
  output: string,
  reducer: (line: string, accumulator: T) => T,
  initialValue: T,
): T {
  const lines = output.split('\n');
  let result = initialValue;

  for (const line of lines) {
    if (shouldSkipLine(line)) {
      continue;
    }
    result = reducer(line, result);
  }

  return result;
}

/**
 * Parse TXT record from output
 */
function parseTxtRecord(output: string): Record<string, string> {
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
function shouldSkipLine(line: string): boolean {
  return (
    line.includes('Timestamp') || line.includes('---') || line.trim() === ''
  );
}

/**
 * Resolve hostname to IP address
 */
async function resolveIPAddress(
  hostname: string,
): Promise<string[] | undefined> {
  try {
    const address = await resolve4(hostname);
    log.info(`[ServiceResolver] Resolved ${hostname} to IPv4: ${address}`);
    return address;
  } catch (error) {
    log.warn(
      `[ServiceResolver] Failed to resolve hostname ${hostname} to IPv4: ${error}`,
    );
    // For .local hostnames, try without the trailing dot
    if (hostname.endsWith('.local.')) {
      const cleanHostname = hostname.slice(0, -1); // Remove trailing dot
      try {
        const address = await resolve4(cleanHostname);
        log.info(
          `[ServiceResolver] Resolved ${cleanHostname} to IPv4: ${address}`,
        );
        return address;
      } catch (retryError) {
        log.warn(
          `[ServiceResolver] Failed to resolve ${cleanHostname} to IPv4: ${retryError}`,
        );
      }
    }
    return undefined;
  }
}

/**
 * Convert a resolved Bonjour service to an Apple TV device with IP resolution
 */
async function convertToAppleTVDeviceWithIP(
  service: BonjourService,
): Promise<AppleTVDevice | null> {
  if (!isValidService(service)) {
    return null;
  }

  const { txtRecord, hostname, port } = service;
  if (!txtRecord || !hasRequiredTxtFields(txtRecord)) {
    log.warn(
      `[AppleTVDeviceConverter] Service ${service.name} missing required TXT record fields`,
    );
    return null;
  }

  if (!hostname || !port) {
    log.warn(
      `[AppleTVDeviceConverter] Service ${service.name} missing hostname or port`,
    );
    return null;
  }

  const ipAddresses = await resolveIPAddress(hostname);
  // Select default first one
  // TODO: needs a decision to select from cli, if the user wants to select from the available ip's
  const ip = ipAddresses?.[0];

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
function isValidService(service: BonjourService): boolean {
  return Boolean(service.hostname && service.port && service.txtRecord);
}

/**
 * Check if TXT record has required fields
 */
function hasRequiredTxtFields(txtRecord: Record<string, string>): boolean {
  return Boolean(txtRecord.identifier && txtRecord.model && txtRecord.ver);
}

/* =========================
 * Main Bonjour discovery service orchestrator
 * =========================
 */
export class BonjourDiscovery extends EventEmitter {
  private _browseProcess?: ChildProcess;
  private _isDiscovering = false;
  private readonly _discoveredServices: Map<string, BonjourService> = new Map();

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
    if (this._browseProcess && !this._browseProcess.killed) {
      log.info('Stopping Bonjour discovery');
      this._browseProcess.kill('SIGTERM');
    }
    this.cleanup();
  }

  /**
   * Get all discovered services
   */
  getDiscoveredServices(): BonjourService[] {
    return Array.from(this._discoveredServices.values());
  }

  /**
   * Resolve a specific service to get detailed information
   */
  async resolveService(
    serviceName: string,
    serviceType: string = BONJOUR_SERVICE_TYPES.APPLE_TV_PAIRING,
    domain: string = BONJOUR_DEFAULT_DOMAIN,
  ): Promise<BonjourService> {
    log.info(
      `[ServiceResolver] Resolving service: ${serviceName}.${serviceType}.${domain}`,
    );

    const service = await executeDnsSdCommand<BonjourService | null>(
      [DNS_SD_COMMANDS.RESOLVE, serviceName, serviceType, domain],
      BONJOUR_TIMEOUTS.SERVICE_RESOLUTION,
      (output: string) =>
        parseResolveOutput(output, serviceName, serviceType, domain),
      `Service resolution timeout for ${serviceName}`,
    );

    if (!service) {
      throw new Error(`Failed to resolve service ${serviceName}`);
    }

    return service;
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
      await delay(timeoutMs);

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
   * Process browse output using the parser
   */
  processBrowseOutput(output: string): void {
    const results = parseBrowseOutput(output);

    for (const { action, service } of results) {
      switch (action) {
        case DNS_SD_ACTIONS.ADD:
          this._discoveredServices.set(service.name, service);
          this.emit('serviceAdded', service);
          log.info(`Discovered service: ${service.name}`);
          break;
        case DNS_SD_ACTIONS.REMOVE:
          this._discoveredServices.delete(service.name);
          this.emit('serviceRemoved', service.name);
          log.info(`Service removed: ${service.name}`);
          break;
        default:
          log.debug(`Unknown action: ${action}`);
          break;
      }
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
    this._discoveredServices.clear();

    const browseProcess = createDnsSdBrowseProcess(serviceType, domain);
    this._browseProcess = browseProcess;

    try {
      await executeDnsSdCommand(
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
    });
    process.on('close', (code: number | null) => {
      log.debug(`dns-sd browse process closed with code: ${code}`);
      this.cleanup();
    });
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
        const device = await convertToAppleTVDeviceWithIP(resolvedService);

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
    log.debug('Cleaning up BonjourDiscovery resources');
    this._browseProcess = undefined;
    this._isDiscovering = false;
    this._discoveredServices.clear();
  }
}
