import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import posixpath from 'node:path/posix';

import { getLogger } from '../../../lib/logger.js';
import { createBinaryPlist, parsePlist } from '../../../lib/plist/index.js';
import AfcService from '../afc/index.js';
import { BaseService } from '../base-service.js';

const log = getLogger('CrashReportsService');

/**
 * Path that is sometimes auto-created after deletion
 */
const APPSTORED_PATH = '/com.apple.appstored';

/**
 * Options for the pull operation
 */
export interface PullOptions {
  erase?: boolean;
  match?: RegExp | string;
}

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

  private afc: AfcService;
  private crashMoverAddress: [string, number];

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
  async pull(out: string, entry = '/', options?: PullOptions): Promise<void> {
    const { erase = false, match } = options ?? {};
    const matchPattern =
      typeof match === 'string' ? new RegExp(match) : (match ?? null);

    log.debug(
      `Pulling crash reports from '${entry}' to '${out}', erase: ${erase}`,
    );

    if (!fs.existsSync(out)) {
      fs.mkdirSync(out, { recursive: true });
    }

    await this._pullRecursive(entry, out, matchPattern, erase);
  }

  /**
   * Clear all crash reports from the device.
   * Removes all files and folders from the crash reports directory.
   * @throws Error if some items could not be deleted (except for auto-created paths)
   */
  async clear(): Promise<void> {
    log.debug('Clearing all crash reports');

    const entries = await this.afc.listdir('/');
    const undeletedItems: string[] = [];

    for (const entry of entries) {
      const fullPath = posixpath.join('/', entry);
      const failedPaths = await this.afc.rm(fullPath, true);
      undeletedItems.push(...failedPaths);
    }

    // Filter out special paths that are auto-created
    const realFailures = undeletedItems.filter(
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
   * Helper to perform RSD handshake and read raw bytes response
   * Used for services that send plist messages followed by raw bytes
   */
  private async rsdHandshakeAndReadRaw(
    hostname: string,
    port: string,
    expectedBytes: number,
  ): Promise<Buffer> {
    const socket = await new Promise<net.Socket>((resolve, reject) => {
      const conn = net.createConnection(
        { host: hostname, port: Number(port) },
        () => {
          conn.setTimeout(0);
          conn.setKeepAlive(true);
          resolve(conn);
        },
      );
      conn.setTimeout(10000, () => {
        conn.destroy();
        reject(new Error('Connection timed out'));
      });
      conn.on('error', reject);
    });

    try {
      let buffer = Buffer.alloc(0);
      const ensureData = (minBytes: number, timeout: number): Promise<void> => {
        if (buffer.length >= minBytes) {return Promise.resolve();}
        return new Promise((resolve, reject) => {
          const onData = (chunk: Buffer) => {
            buffer = Buffer.concat([buffer, chunk]);
            if (buffer.length >= minBytes) {
              socket.removeListener('data', onData);
              socket.removeListener('error', onError);
              clearTimeout(timeoutId);
              resolve();
            }
          };
          const onError = (err: Error) => {
            socket.removeListener('data', onData);
            socket.removeListener('error', onError);
            clearTimeout(timeoutId);
            reject(err);
          };
          socket.on('data', onData);
          socket.on('error', onError);
          const timeoutId = setTimeout(() => {
            socket.removeListener('data', onData);
            socket.removeListener('error', onError);
            reject(new Error(`Timeout waiting for ${minBytes} bytes`));
          }, timeout);
        });
      };

      const readBytes = (numBytes: number): Buffer => {
        const data = buffer.slice(0, numBytes);
        buffer = buffer.slice(numBytes);
        return data;
      };

      const receivePlist = async (): Promise<any> => {
        await ensureData(4, 5000);
        const length = readBytes(4).readUInt32BE(0);
        await ensureData(length, 5000);
        return parsePlist(readBytes(length));
      };

      // Send RSDCheckin
      const checkinPlist = createBinaryPlist({
        Label: 'appium-internal',
        ProtocolVersion: '2',
        Request: 'RSDCheckin',
      });
      const header = Buffer.alloc(4);
      header.writeUInt32BE(checkinPlist.length, 0);
      socket.write(Buffer.concat([header, checkinPlist]));

      // Receive and validate RSDCheckin response
      const checkinResponse = await receivePlist();
      if (checkinResponse?.Request !== 'RSDCheckin') {
        throw new Error(
          `Invalid RSDCheckin response: ${JSON.stringify(checkinResponse)}`,
        );
      }

      // Receive and validate StartService response
      const startServiceResponse = await receivePlist();
      if (startServiceResponse?.Request !== 'StartService') {
        throw new Error(
          `Invalid StartService response: ${JSON.stringify(startServiceResponse)}`,
        );
      }

      // Read raw bytes
      await ensureData(expectedBytes, 10000);
      return readBytes(expectedBytes);
    } finally {
      socket.destroy();
    }
  }

  /**
   * Trigger com.apple.crashreportmover to flush all products into CrashReports directory
   */
  async flush(): Promise<void> {
    log.debug('Flushing crash reports');

    const ack = await this.rsdHandshakeAndReadRaw(
      this.crashMoverAddress[0],
      this.crashMoverAddress[1].toString(),
      5,
    );

    const expectedAck = Buffer.from('ping\0', 'utf8');
    if (!ack.equals(expectedAck)) {
      throw new Error(
        `Unexpected flush acknowledgment. Expected: ${expectedAck.toString('hex')}, Got: ${ack.toString('hex')}`,
      );
    }

    log.debug('Successfully flushed crash reports');
  }

  /**
   * Close the service and release resources
   */
  close(): void {
    log.debug('Closing CrashReportsService');
    try {
      this.afc.close();
    } catch {
      // Ignore close errors
    }
  }

  /**
   * Recursive helper for pulling files and directories
   */
  private async _pullRecursive(
    remotePath: string,
    localDir: string,
    matchPattern: RegExp | null,
    erase: boolean,
  ): Promise<void> {
    log.debug(`_pullRecursive: remotePath=${remotePath}, localDir=${localDir}`);

    let isDir: boolean;
    try {
      isDir = await this.afc.isdir(remotePath);
      log.debug(`Path ${remotePath} isDir: ${isDir}`);
    } catch (error) {
      log.error(`Failed to check if ${remotePath} is directory: ${error}`);
      throw error;
    }

    if (!isDir) {
      const fileName = posixpath.basename(remotePath);
      log.debug(`Processing file: ${fileName}`);

      if (matchPattern && !matchPattern.test(fileName)) {
        log.debug(`File ${fileName} does not match pattern, skipping`);
        return;
      }

      const localPath = path.join(localDir, fileName);
      try {
        log.debug(`Pulling file: ${remotePath} -> ${localPath}`);
        await this.afc.pull(remotePath, localPath);
        log.debug(`Successfully pulled: ${remotePath}`);

        if (erase) {
          log.debug(`Erasing remote file: ${remotePath}`);
          await this.afc.rmSingle(remotePath, true);
        }
      } catch (error) {
        log.error(`Failed to pull file '${remotePath}': ${error}`);
        // Continue with other files (ignore_errors behavior)
      }
    } else {
      const dirName = posixpath.basename(remotePath);
      log.debug(`Processing directory: ${dirName}`);

      if (matchPattern && !matchPattern.test(dirName) && remotePath !== '/') {
        log.debug(`Directory ${dirName} does not match pattern, skipping`);
        return;
      }

      const localDirPath =
        remotePath === '/' ? localDir : path.join(localDir, dirName);

      if (!fs.existsSync(localDirPath)) {
        log.debug(`Creating local directory: ${localDirPath}`);
        fs.mkdirSync(localDirPath, { recursive: true });
      }

      try {
        log.debug(`Listing directory: ${remotePath}`);
        const entries = await this.afc.listdir(remotePath);
        log.debug(`Found ${entries.length} entries in ${remotePath}`);

        for (const entry of entries) {
          const entryPath = posixpath.join(remotePath, entry);
          await this._pullRecursive(
            entryPath,
            localDirPath,
            matchPattern,
            erase,
          );
        }
      } catch (error) {
        log.error(`Failed to list directory '${remotePath}': ${error}`);
        // Continue with other directories
      }
    }
  }
}

export default CrashReportsService;
