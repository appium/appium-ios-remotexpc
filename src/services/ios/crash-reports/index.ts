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
  async pull(
    out: string,
    entry = '/',
    options?: PullOptions,
  ): Promise<void> {
    const { erase = false, match } = options ?? {};
    const matchPattern =
      typeof match === 'string' ? new RegExp(match) : match ?? null;

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
   * Trigger com.apple.crashreportmover to flush all products into CrashReports directory
   */
  async flush(): Promise<void> {
    log.debug('Flushing crash reports');

    const port = this.crashMoverAddress[1].toString();
    const hostname = this.crashMoverAddress[0];

    // Create raw TCP connection without plist pipeline to handle mixed plist/raw protocol
    const socket = await new Promise<net.Socket>((resolve, reject) => {
      const conn = net.createConnection({ host: hostname, port: Number(port) }, () => {
        conn.setTimeout(0);
        conn.setKeepAlive(true);
        resolve(conn);
      });
      conn.setTimeout(10000, () => {
        conn.destroy();
        reject(new Error('Connection timed out'));
      });
      conn.on('error', reject);
    });

    try {
      // Buffer manager for reading from socket
      let buffer = Buffer.alloc(0);
      const dataChunks: Buffer[] = [];
      let dataResolver: ((value: void) => void) | null = null;

      socket.on('data', (chunk: Buffer) => {
        dataChunks.push(chunk);
        if (dataResolver) {
          dataResolver();
          dataResolver = null;
        }
      });

      const ensureData = async (): Promise<void> => {
        if (dataChunks.length > 0) {
          buffer = Buffer.concat([buffer, ...dataChunks]);
          dataChunks.length = 0;
          return;
        }
        
        await new Promise<void>((resolve, reject) => {
          dataResolver = resolve;
          const timeoutId = setTimeout(() => {
            dataResolver = null;
            reject(new Error('Timeout waiting for data'));
          }, 10000);

          socket.once('error', (err) => {
            clearTimeout(timeoutId);
            dataResolver = null;
            reject(err);
          });
        });

        buffer = Buffer.concat([buffer, ...dataChunks]);
        dataChunks.length = 0;
      };

      const readBytes = async (length: number): Promise<Buffer> => {
        while (buffer.length < length) {
          await ensureData();
        }
        const result = buffer.slice(0, length);
        buffer = buffer.slice(length);
        return result;
      };

      const receivePlist = async (): Promise<any> => {
        const lengthBuf = await readBytes(4);
        const payloadLength = lengthBuf.readUInt32BE(0);
        const payloadBuf = await readBytes(payloadLength);
        return parsePlist(payloadBuf);
      };

      // Send RSDCheckin as plist
      const checkin = {
        Label: 'appium-internal',
        ProtocolVersion: '2',
        Request: 'RSDCheckin',
      };

      log.debug('Sending RSDCheckin for flush');
      const checkinPlist = createBinaryPlist(checkin);
      const checkinHeader = Buffer.alloc(4);
      checkinHeader.writeUInt32BE(checkinPlist.length, 0);
      socket.write(Buffer.concat([checkinHeader, checkinPlist]));

      // Receive RSDCheckin response
      const checkinResponse = await receivePlist();
      log.debug(`Flush RSDCheckin response: ${JSON.stringify(checkinResponse)}`);

      if (checkinResponse?.Request !== 'RSDCheckin') {
        throw new Error(
          `Invalid response for RSDCheckin: ${JSON.stringify(checkinResponse)}. Expected "RSDCheckin"`,
        );
      }

      // Receive StartService response
      log.debug('Consuming StartService response');
      const startServiceResponse = await receivePlist();
      log.debug(`Flush StartService response: ${JSON.stringify(startServiceResponse)}`);

      if (startServiceResponse?.Request !== 'StartService') {
        throw new Error(
          `Invalid response for StartService: ${JSON.stringify(startServiceResponse)}. Expected "StartService"`,
        );
      }

      // Now read raw bytes: "ping\0"
      const expectedAck = Buffer.from('ping\0', 'utf8');
      log.debug('Waiting for ping acknowledgment (raw bytes)');

      const ack = await readBytes(expectedAck.length);
      log.debug(`Received ack: ${ack.toString('hex')}`);

      if (!ack.equals(expectedAck)) {
        log.warn(
          `Unexpected flush acknowledgment. Expected: ${expectedAck.toString('hex')}, Got: ${ack.toString('hex')}`,
        );
      } else {
        log.debug('Successfully flushed crash reports');
      }
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
          await this._pullRecursive(entryPath, localDirPath, matchPattern, erase);
        }
      } catch (error) {
        log.error(`Failed to list directory '${remotePath}': ${error}`);
        // Continue with other directories
      }
    }
  }
}

export default CrashReportsService;
