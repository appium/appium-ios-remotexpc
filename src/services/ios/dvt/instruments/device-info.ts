import { getLogger } from '../../../../lib/logger.js';
import { parseBinaryPlist } from '../../../../lib/plist/index.js';
import type { ProcessInfo } from '../../../../lib/types.js';
import type { Channel } from '../channel.js';
import { MessageAux } from '../dtx-message.js';
import type { DVTSecureSocketProxyService } from '../index.js';

const log = getLogger('DeviceInfo');

/**
 * DeviceInfo service provides access to device information, file system,
 * and process management through the DTX protocol.
 *
 * Available methods:
 * - ls(path): List directory contents
 * - execnameForPid(pid): Get executable path for a process ID
 * - proclist(): Get list of running processes
 * - isRunningPid(pid): Check if a process is running
 * - hardwareInformation(): Get hardware details
 * - networkInformation(): Get network configuration
 * - machTimeInfo(): Get mach time information
 * - machKernelName(): Get kernel name
 * - kpepDatabase(): Get kernel performance event database
 * - traceCodes(): Get trace code mappings
 * - nameForUid(uid): Get username for UID
 * - nameForGid(gid): Get group name for GID
 */
export class DeviceInfo {
  static readonly IDENTIFIER =
    'com.apple.instruments.server.services.deviceinfo';

  private channel: Channel | null = null;

  constructor(private readonly dvt: DVTSecureSocketProxyService) {}

  /**
   * Initialize the device info channel
   */
  async initialize(): Promise<void> {
    if (!this.channel) {
      this.channel = await this.dvt.makeChannel(DeviceInfo.IDENTIFIER);
    }
  }

  /**
   * List directory contents at the specified path.
   * @param path - The directory path to list
   * @returns Array of filenames
   * @throws {Error} If the directory doesn't exist or cannot be accessed
   */
  async ls(path: string): Promise<string[]> {
    await this.initialize();

    const args = new MessageAux().appendObj(path);
    await this.channel!.call('directoryListingForPath_')(args);

    const result = await this.channel!.receivePlist();

    if (result === null || result === undefined) {
      throw new Error(`Failed to list directory: ${path}`);
    }

    log.debug(`Listed directory ${path}: ${result.length} entries`);
    return result as string[];
  }

  /**
   * Get the full executable path for a given process ID.
   * @param pid - The process identifier
   * @returns The full path to the executable
   */
  async execnameForPid(pid: number): Promise<string> {
    await this.initialize();

    const args = new MessageAux().appendObj(pid);
    await this.channel!.call('execnameForPid_')(args);

    const result = await this.channel!.receivePlist();
    return result as string;
  }

  /**
   * Get the list of all running processes on the device.
   * @returns Array of process information objects
   */
  async proclist(): Promise<ProcessInfo[]> {
    await this.initialize();

    await this.channel!.call('runningProcesses')();
    const result = await this.channel!.receivePlist();

    if (!Array.isArray(result)) {
      throw new Error('Expected array of processes from runningProcesses');
    }

    log.debug(`Retrieved ${result.length} running processes`);
    return result as ProcessInfo[];
  }

  /**
   * Check if a process with the given PID is currently running.
   * @param pid - The process identifier to check
   * @returns true if the process is running, false otherwise
   */
  async isRunningPid(pid: number): Promise<boolean> {
    await this.initialize();

    const args = new MessageAux().appendObj(pid);
    await this.channel!.call('isRunningPid_')(args);

    const result = await this.channel!.receivePlist();
    return result as boolean;
  }

  /**
   * Get hardware information about the device.
   * @returns Object containing hardware information
   */
  async hardwareInformation(): Promise<any> {
    return this.requestInformation('hardwareInformation');
  }

  /**
   * Get network configuration information.
   * @returns Object containing network information
   */
  async networkInformation(): Promise<any> {
    return this.requestInformation('networkInformation');
  }

  /**
   * Get mach kernel time information.
   * @returns Object containing mach time info
   */
  async machTimeInfo(): Promise<any> {
    return this.requestInformation('machTimeInfo');
  }

  /**
   * Get the mach kernel name.
   * @returns The kernel name string
   */
  async machKernelName(): Promise<string> {
    return this.requestInformation('machKernelName');
  }

  /**
   * Get the kernel performance event (kpep) database.
   * @returns Object containing kpep database or null if not available
   */
  async kpepDatabase(): Promise<any | null> {
    const kpepData = await this.requestInformation('kpepDatabase');

    if (kpepData === null || kpepData === undefined) {
      return null;
    }

    // The kpepDatabase is returned as binary plist data
    if (Buffer.isBuffer(kpepData)) {
      try {
        return parseBinaryPlist(kpepData);
      } catch (error) {
        log.warn('Failed to parse kpep database:', error);
        return null;
      }
    }

    return kpepData;
  }

  /**
   * Get trace code mappings.
   * @returns Object mapping trace codes (as numbers) to descriptions
   */
  async traceCodes(): Promise<Record<number, string>> {
    const codesFile = await this.requestInformation('traceCodesFile');

    if (!codesFile || typeof codesFile !== 'string') {
      return {};
    }

    // Parse the trace codes file format: "hexcode description"
    const codes: Record<number, string> = {};
    const lines = codesFile.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      // Split on whitespace (one or more spaces/tabs)
      const match = trimmed.match(/^(\S+)\s+(.+)$/);
      if (match) {
        const hexCode = match[1];
        const description = match[2];

        try {
          // Parse hex string to number
          const codeNum = parseInt(hexCode, 16);
          if (!isNaN(codeNum)) {
            codes[codeNum] = description;
          }
        } catch (error) {
          log.debug(`Failed to parse trace code: ${hexCode}`);
        }
      }
    }

    log.debug(`Retrieved ${Object.keys(codes).length} trace codes`);
    return codes;
  }

  /**
   * Get the username for a given user ID (UID).
   * @param uid - The user identifier
   * @returns The username string
   */
  async nameForUid(uid: number): Promise<string> {
    await this.initialize();

    const args = new MessageAux().appendObj(uid);
    await this.channel!.call('nameForUID_')(args);

    const result = await this.channel!.receivePlist();
    return result as string;
  }

  /**
   * Get the group name for a given group ID (GID).
   * @param gid - The group identifier
   * @returns The group name string
   */
  async nameForGid(gid: number): Promise<string> {
    await this.initialize();

    const args = new MessageAux().appendObj(gid);
    await this.channel!.call('nameForGID_')(args);

    const result = await this.channel!.receivePlist();
    return result as string;
  }

  /**
   * Generic method to request information from the device.
   * @param selectorName - The selector name to call
   * @returns The information object or value returned by the selector
   * @private
   */
  private async requestInformation(selectorName: string): Promise<any> {
    await this.initialize();
    await this.channel!.call(selectorName)();

    return await this.channel!.receivePlist();
  }
}
