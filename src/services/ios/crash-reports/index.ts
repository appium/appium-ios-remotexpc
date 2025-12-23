import fs from 'node:fs';
import posixpath from 'node:path/posix';

import { getLogger } from '../../../lib/logger.js';
import type { CrashReportsPullOptions } from '../../../lib/types.js';
import { createRawServiceSocket, readExact } from '../afc/codec.js';
import { AfcService } from '../afc/index.js';
import { BaseService } from '../base-service.js';

const log = getLogger('CrashReportsService');

/**
 * Path that is sometimes auto-created after deletion
 */
const APPSTORED_PATH = '/com.apple.appstored';

/**
 * CrashReportsService provides an API to:
 * - List crash reports on the device (ls)
 * - Pull crash reports from the device to the local machine (pull)
 * - Clear all crash reports from the device (clear)
 * - Flush crash report products into CrashReports directory (flush)
 *
 * This service uses the com.apple.crashreportcopymobile.shim.remote for AFC operations
 * and com.apple.crashreportmover.shim.remote for flush operations.
 */
export class CrashReportsService extends BaseService {
  static readonly RSD_COPY_MOBILE_NAME =
    'com.apple.crashreportcopymobile.shim.remote';
  static readonly RSD_CRASH_MOVER_NAME =
    'com.apple.crashreportmover.shim.remote';

  private readonly afc: AfcService;
  private readonly crashMoverAddress: [string, number];

  /**
   * Creates a new CrashReportsService instance
   * @param afcAddress Tuple containing [host, port] for the AFC service
   * @param crashMoverAddress Tuple containing [host, port] for the crash mover service
   */
  constructor(
    afcAddress: [string, number],
    crashMoverAddress: [string, number],
  ) {
    super(afcAddress);
    this.afc = new AfcService(afcAddress, true);
    this.crashMoverAddress = crashMoverAddress;
  }

  /**
   * List files and folders in the crash report's directory.
   * @param dirPath Path to list, relative to the crash report's directory. Defaults to "/"
   * @param depth Listing depth. 1 for immediate children, -1 for infinite depth
   * @returns List of file paths listed
   */
  async ls(dirPath = '/', depth = 1): Promise<string[]> {
    log.debug(`Listing crash reports at path: ${dirPath}, depth: ${depth}`);

    if (depth === 0) {
      return [];
    }

    const results: string[] = [];
    const entries = await this.afc.listdir(dirPath);

    for (const entry of entries) {
      const entryPath = posixpath.join(dirPath, entry);
      results.push(entryPath);

      if (depth !== 1) {
        try {
          if (await this.afc.isdir(entryPath)) {
            const newDepth = depth === -1 ? -1 : depth - 1;
            const subEntries = await this.ls(entryPath, newDepth);
            results.push(...subEntries);
          }
        } catch {
          // Skip entries we can't access
        }
      }
    }

    return results;
  }

  /**
   * Pull crash reports from the device to the local machine.
   * @param out Local directory path
   * @param entry Remote path on device, defaults to "/"
   * @param options Pull options (erase, match pattern)
   */
  async pull(
    out: string,
    entry = '/',
    options?: CrashReportsPullOptions,
  ): Promise<void> {
    const { erase = false, match } = options ?? {};

    log.debug(
      `Pulling crash reports from '${entry}' to '${out}', erase: ${erase}`,
    );

    if (!fs.existsSync(out)) {
      fs.mkdirSync(out, { recursive: true });
    }

    await this.afc.pull(entry, out, {
      recursive: true,
      match,
      callback: erase
        ? async (remotePath) => {
            await this.afc.rmSingle(remotePath, true);
          }
        : undefined,
    });
  }

  /**
   * Clear all crash reports from the device.
   * Removes all files and folders from the crash reports directory.
   * @throws Error if some items could not be deleted (except for auto-created paths)
   */
  async clear(): Promise<void> {
    log.debug('Clearing all crash reports');

    const entries = await this.afc.listdir('/');
    const nonDeletedItems: string[] = [];

    for (const entry of entries) {
      const fullPath = posixpath.join('/', entry);
      const failedPaths = await this.afc.rm(fullPath, true);
      nonDeletedItems.push(...failedPaths);
    }

    // Filter out special paths that are auto-created
    const realFailures = nonDeletedItems.filter(
      (item) => item !== APPSTORED_PATH,
    );

    if (realFailures.length > 0) {
      throw new Error(
        `Failed to clear crash reports directory, undeleted items: ${realFailures.join(', ')}`,
      );
    }

    log.debug('Successfully cleared all crash reports');
  }

  /**
   * Trigger com.apple.crashreportmover to flush all products into CrashReports directory
   */
  async flush(): Promise<void> {
    log.debug('Flushing crash reports');

    const socket = await createRawServiceSocket(
      this.crashMoverAddress[0],
      this.crashMoverAddress[1],
    );
    try {
      const ack = await readExact(socket, 5, 10000);
      const expectedAck = Buffer.from('ping\0', 'utf8');
      if (!ack.equals(expectedAck)) {
        throw new Error(
          `Unexpected flush acknowledgment. Expected: ${expectedAck.toString('hex')}, Got: ${ack.toString('hex')}`,
        );
      }
      log.debug('Successfully flushed crash reports');
    } finally {
      socket.destroy();
    }
  }

  /**
   * Close the service and release resources
   */
  close(): void {
    log.debug('Closing CrashReportsService');
    try {
      this.afc.close();
    } catch {}
  }
}

export default CrashReportsService;
