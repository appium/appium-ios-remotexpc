import { getLogger } from '../../../../lib/logger.js';
import { parseBinaryPlist } from '../../../../lib/plist/index.js';
import type { ProcessInfo } from '../../../../lib/types.js';
import { MessageAux } from '../dtx-message.js';
import { hasNSErrorIndicators } from '../utils.js';
import { BaseInstrument } from './base-instrument.js';

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
export class DeviceInfo extends BaseInstrument {
  static readonly IDENTIFIER =
    'com.apple.instruments.server.services.deviceinfo';

  /**
   * List directory contents at the specified path.
   * @param path - The directory path to list
   * @returns Array of filenames
   * @throws {Error} If the directory doesn't exist or cannot be accessed
   */
  async ls(path: string): Promise<string[]> {
    const result = await this.requestInformation(
      'directoryListingForPath_',
      path,
    );

    if (result === null || result === undefined) {
      throw new Error(`Failed to list directory: ${path}`);
    }

    log.debug(`Listed directory ${path}: ${result.length} entries`);
    return result;
  }

  /**
   * Get the full executable path for a given process ID.
   * @param pid - The process identifier
   * @returns The full path to the executable
   */
  async execnameForPid(pid: number): Promise<string> {
    return this.requestInformation('execnameForPid_', pid);
  }

  /**
   * Get the list of all running processes on the device.
   * @returns Array of process information objects
   */
  async proclist(): Promise<ProcessInfo[]> {
    const result = await this.requestInformation('runningProcesses');

    if (!Array.isArray(result)) {
      throw new Error(
        `proclist returned invalid data: expected an array, got ${typeof result} (${JSON.stringify(result)})`,
      );
    }

    log.debug(`Retrieved ${result.length} running processes`);
    return result;
  }

  /**
   * Check if a process with the given PID is currently running.
   * @param pid - The process identifier to check
   * @returns true if the process is running, false otherwise
   */
  async isRunningPid(pid: number): Promise<boolean> {
    return this.requestInformation('isRunningPid_', pid);
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
   * @returns Object mapping trace codes (as hex strings) to descriptions
   */
  async traceCodes(): Promise<Record<string, string>> {
    const codesFile = await this.requestInformation('traceCodesFile');
    if (typeof codesFile !== 'string') {
      return {};
    }

    const codes: Record<string, string> = {};

    for (const line of codesFile.split('\n')) {
      const match = line.trim().match(/^(\S+)\s+(.+)$/);
      if (match) {
        const [, hex, description] = match;
        codes[hex] = description;
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
    return this.expectStringResult(
      await this.requestInformation('nameForUID_', uid),
      `nameForUid(${uid})`,
    );
  }

  /**
   * Get the group name for a given group ID (GID).
   * @param gid - The group identifier
   * @returns The group name string
   * @throws {Error} When the selector is unavailable or lookup fails
   */
  async nameForGid(gid: number): Promise<string> {
    return this.expectStringResult(
      await this.requestInformation('nameForGID_', gid),
      `nameForGid(${gid})`,
    );
  }

  /**
   * Get the list of process attribute names supported by the sysmontap
   * instrument. The returned order matches the per-process value tuples
   * emitted by the sysmontap service, so it is used to label those values.
   * @returns Array of process attribute names (e.g. 'pid', 'name', 'cpuUsage')
   */
  async sysmonProcessAttributes(): Promise<string[]> {
    return this.expectStringArrayResult(
      await this.requestInformation('sysmonProcessAttributes'),
      'sysmonProcessAttributes',
    );
  }

  /**
   * Get the list of system attribute names supported by the sysmontap
   * instrument. The returned order matches the system value tuple emitted by
   * the sysmontap service, so it is used to label those values.
   * @returns Array of system attribute names (e.g. 'vmPageSize', 'physMemSize')
   */
  async sysmonSystemAttributes(): Promise<string[]> {
    return this.expectStringArrayResult(
      await this.requestInformation('sysmonSystemAttributes'),
      'sysmonSystemAttributes',
    );
  }

  private expectStringArrayResult(result: unknown, context: string): string[] {
    if (
      Array.isArray(result) &&
      result.every((item) => typeof item === 'string')
    ) {
      return result;
    }

    if (hasNSErrorIndicators(result)) {
      const description =
        (result as { NSUserInfo?: { NSLocalizedDescription?: string } })
          .NSUserInfo?.NSLocalizedDescription ?? JSON.stringify(result);
      throw new Error(`${context}: ${description}`);
    }

    throw new Error(
      `${context}: expected string array, got ${typeof result} (${JSON.stringify(result)})`,
    );
  }

  private expectStringResult(result: unknown, context: string): string {
    if (typeof result === 'string') {
      return result;
    }

    if (hasNSErrorIndicators(result)) {
      const description =
        (result as { NSUserInfo?: { NSLocalizedDescription?: string } })
          .NSUserInfo?.NSLocalizedDescription ?? JSON.stringify(result);
      throw new Error(`${context}: ${description}`);
    }

    throw new Error(
      `${context}: expected string, got ${typeof result} (${JSON.stringify(result)})`,
    );
  }

  /**
   * Generic method to request information from the device.
   * @param selectorName - The selector name to call
   * @param arg - Optional argument to pass to the selector
   * @returns The information object or value returned by the selector
   * @private
   */
  private async requestInformation(
    selectorName: string,
    arg?: any,
  ): Promise<any> {
    await this.initialize();
    const channel = this.requireChannel();

    const call = channel.call(selectorName);
    const args =
      arg !== undefined ? new MessageAux().appendObj(arg) : undefined;

    await call(args);
    return channel.receivePlist();
  }
}
