import { logger } from '@appium/support';
import { readFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

import {
  buildClosePayload,
  buildFopenPayload,
  buildReadPayload,
  buildRemovePayload,
  buildRenamePayload,
  buildStatPayload,
  nextReadChunkSize,
  parseCStringArray,
  parseKeyValueNullList,
  readAfcResponse,
  rsdHandshakeForRawService,
  sendAfcPacket,
  writeUInt64LE,
} from './codec.js';
import {
  AFC_FOPEN_TEXTUAL_MODES,
  AFC_RSD_SERVICE_NAME,
  AFC_WRITE_THIS_LENGTH,
  MAXIMUM_READ_SIZE,
} from './constants.js';
import { AfcError, AfcOpcode } from './enums.js';

const log = logger.getLogger('AfcService');

export interface StatInfo {
  st_ifmt: string;
  st_size: number;
  st_blocks: number;
  st_mtime: Date;
  st_birthtime: Date;
  st_nlink: number;
  LinkTarget?: string;
  [k: string]: any;
}

/**
 * AFC client over RSD (Remote XPC shim).
 * After RSDCheckin, speaks raw AFC protocol on the same socket.
 */
export class AfcService {
  static readonly RSD_SERVICE_NAME = AFC_RSD_SERVICE_NAME;

  private readonly address: [string, number];
  private socket: net.Socket | null = null;
  private packetNum: bigint = 0n;

  constructor(address: [string, number]) {
    this.address = address;
  }

  /**
   * List directory entries. Returned entries do not include '.' and '..'
   */
  async listdir(dirPath: string): Promise<string[]> {
    const data = await this._doOperation(
      AfcOpcode.READ_DIR,
      buildStatPayload(dirPath),
    );
    const entries = parseCStringArray(data);
    // Skip '.' and '..'
    return entries.slice(2).filter((x) => x !== '');
  }

  async stat(filePath: string, silent = false): Promise<StatInfo> {
    log.debug(`Getting file info for: ${filePath}`);
    try {
      const data = await this._doOperation(
        AfcOpcode.GET_FILE_INFO,
        buildStatPayload(filePath),
      );
      const kv = parseKeyValueNullList(data);

      const out: StatInfo = {
        st_ifmt: kv.st_ifmt,
        st_size: Number.parseInt(kv.st_size, 10),
        st_blocks: Number.parseInt(kv.st_blocks, 10),
        st_mtime: new Date(Number.parseInt(kv.st_mtime, 10) / 1e6), // ns -> ms
        st_birthtime: new Date(Number.parseInt(kv.st_birthtime, 10) / 1e6), // ns -> ms
        st_nlink: Number.parseInt(kv.st_nlink, 10),
      };
      if (kv.LinkTarget) {
        out.LinkTarget = kv.LinkTarget;
      }
      for (const [k, v] of Object.entries(kv)) {
        if (!(k in out)) {
          (out as any)[k] = v;
        }
      }
      return out;
    } catch (error) {
      if (!silent) {
        log.error(`Failed to stat file '${filePath}':`, error);
      }
      throw error;
    }
  }

  async isdir(filePath: string): Promise<boolean> {
    const st = await this.stat(filePath);
    return st.st_ifmt === 'S_IFDIR';
  }

  async exists(filePath: string): Promise<boolean> {
    try {
      await this.stat(filePath, true);
      return true;
    } catch {
      return false;
    }
  }

  async fopen(
    filePath: string,
    mode: keyof typeof AFC_FOPEN_TEXTUAL_MODES = 'r',
  ): Promise<bigint> {
    const afcMode = AFC_FOPEN_TEXTUAL_MODES[mode];
    if (afcMode == null) {
      const allowedModes = Object.keys(AFC_FOPEN_TEXTUAL_MODES).join(', ');
      log.error(`Invalid fopen mode '${mode}'. Allowed modes: ${allowedModes}`);
      throw new Error(`Invalid fopen mode '${mode}'. Allowed: ${allowedModes}`);
    }

    log.debug(`Opening file '${filePath}' with mode '${mode}'`);
    try {
      const data = await this._doOperation(
        AfcOpcode.FILE_OPEN,
        buildFopenPayload(afcMode, filePath),
      );
      // Response data contains UInt64LE 'handle'
      const handle = data.readBigUInt64LE(0);
      log.debug(`File opened successfully, handle: ${handle}`);
      return handle;
    } catch (error) {
      log.error(
        `Failed to open file '${filePath}' with mode '${mode}':`,
        error,
      );
      throw error;
    }
  }

  async fclose(handle: bigint): Promise<void> {
    await this._doOperation(AfcOpcode.FILE_CLOSE, buildClosePayload(handle));
  }

  async fread(handle: bigint, size: number): Promise<Buffer> {
    log.debug(`Reading ${size} bytes from handle ${handle}`);
    const chunks: Buffer[] = [];
    let left = size;
    let totalRead = 0;

    while (left > 0) {
      const toRead = nextReadChunkSize(left);
      await this._dispatch(AfcOpcode.READ, buildReadPayload(handle, toRead));
      const { status, data } = await this._receive();
      if (status !== AfcError.SUCCESS) {
        const errorName = AfcError[status] || 'UNKNOWN';
        log.error(`Read operation failed with status ${errorName} (${status})`);
        throw new Error(`fread error: ${errorName} (${status})`);
      }
      chunks.push(data);
      totalRead += data.length;
      left -= toRead;
      if (data.length < toRead) {
        log.debug(`Reached EOF after reading ${totalRead} bytes`);
        break;
      }
    }

    log.debug(`Successfully read ${totalRead} bytes`);
    return Buffer.concat(chunks);
  }

  async fwrite(
    handle: bigint,
    data: Buffer,
    chunkSize = Number.MAX_SAFE_INTEGER,
  ): Promise<void> {
    log.debug(`Writing ${data.length} bytes to handle ${handle}`);
    const effectiveChunkSize = Math.min(chunkSize, MAXIMUM_READ_SIZE * 256);
    let offset = 0;
    let chunkCount = 0;

    while (offset < data.length) {
      const end = Math.min(offset + effectiveChunkSize, data.length);
      const chunk = data.subarray(offset, end);
      chunkCount++;

      await this._dispatch(
        AfcOpcode.WRITE,
        Buffer.concat([writeUInt64LE(handle), chunk]),
        AFC_WRITE_THIS_LENGTH,
      );
      const { status } = await this._receive();
      if (status !== AfcError.SUCCESS) {
        const errorName = AfcError[status] || 'UNKNOWN';
        log.error(
          `Write operation failed at offset ${offset} with status ${errorName} (${status})`,
        );
        throw new Error(
          `fwrite chunk failed with ${errorName} (${status}) at offset ${offset}`,
        );
      }
      offset = end;
    }

    log.debug(
      `Successfully wrote ${data.length} bytes in ${chunkCount} chunks`,
    );
  }

  async getFileContents(filePath: string): Promise<Buffer> {
    log.debug(`Reading file contents: ${filePath}`);
    const resolved = await this._resolvePath(filePath);
    const st = await this.stat(resolved);
    if (st.st_ifmt !== 'S_IFREG') {
      log.error(
        `Path '${resolved}' is not a regular file (type: ${st.st_ifmt})`,
      );
      throw new Error(`'${resolved}' isn't a regular file`);
    }
    const h = await this.fopen(resolved, 'r');
    try {
      const buf = await this.fread(h, st.st_size);
      log.debug(`Successfully read ${buf.length} bytes from ${filePath}`);
      return buf;
    } finally {
      await this.fclose(h);
    }
  }

  async setFileContents(filePath: string, data: Buffer): Promise<void> {
    log.debug(`Writing ${data.length} bytes to file: ${filePath}`);
    const h = await this.fopen(filePath, 'w');
    try {
      await this.fwrite(h, data);
      log.debug(`Successfully wrote file: ${filePath}`);
    } finally {
      await this.fclose(h);
    }
  }

  async rmSingle(filePath: string, force = false): Promise<boolean> {
    log.debug(`Removing single path: ${filePath} (force: ${force})`);
    try {
      await this._doOperation(
        AfcOpcode.REMOVE_PATH,
        buildRemovePayload(filePath),
      );
      log.debug(`Successfully removed: ${filePath}`);
      return true;
    } catch (error) {
      if (force) {
        log.debug(
          `Failed to remove '${filePath}' (ignored due to force=true):`,
          error,
        );
        return false;
      }
      log.error(`Failed to remove '${filePath}':`, error);
      throw error;
    }
  }

  async rm(filePath: string, force = false): Promise<string[]> {
    if (!(await this.exists(filePath))) {
      if (!(await this.rmSingle(filePath, force))) {
        return [filePath];
      }
      return [];
    }

    if (!(await this.isdir(filePath))) {
      if (await this.rmSingle(filePath, force)) {
        return [];
      }
      return [filePath];
    }

    const undeleted: string[] = [];
    for (const entry of await this.listdir(filePath)) {
      const cur = path.posix.join(filePath, entry);
      if (await this.isdir(cur)) {
        const sub = await this.rm(cur, true);
        undeleted.push(...sub);
      } else {
        if (!(await this.rmSingle(cur, true))) {
          undeleted.push(cur);
        }
      }
    }

    try {
      if (!(await this.rmSingle(filePath, force))) {
        undeleted.push(filePath);
      }
    } catch (err) {
      if (undeleted.length) {
        undeleted.push(filePath);
      } else {
        throw err;
      }
    }

    if (undeleted.length) {
      throw new Error(`Failed to delete paths: ${JSON.stringify(undeleted)}`);
    }
    return [];
  }

  async rename(src: string, dst: string): Promise<void> {
    log.debug(`Renaming '${src}' to '${dst}'`);
    try {
      await this._doOperation(
        AfcOpcode.RENAME_PATH,
        buildRenamePayload(src, dst),
      );
      log.debug(`Successfully renamed '${src}' to '${dst}'`);
    } catch (error) {
      log.error(`Failed to rename '${src}' to '${dst}':`, error);
      throw error;
    }
  }

  async push(localSrc: string, remoteDst: string): Promise<void> {
    log.debug(`Pushing file from '${localSrc}' to '${remoteDst}'`);
    try {
      const buf = await readFile(localSrc);
      await this.setFileContents(remoteDst, buf);
      log.debug(
        `Successfully pushed file to '${remoteDst}' (${buf.length} bytes)`,
      );
    } catch (error) {
      log.error(
        `Failed to push file from '${localSrc}' to '${remoteDst}':`,
        error,
      );
      throw error;
    }
  }

  async walk(
    root: string,
  ): Promise<Array<{ dir: string; dirs: string[]; files: string[] }>> {
    const out: Array<{ dir: string; dirs: string[]; files: string[] }> = [];
    const entries = await this.listdir(root);
    const dirs: string[] = [];
    const files: string[] = [];
    for (const e of entries) {
      const p = path.posix.join(root, e);
      if (await this.isdir(p)) {
        dirs.push(e);
      } else {
        files.push(e);
      }
    }
    out.push({ dir: root, dirs, files });
    for (const d of dirs) {
      out.push(...(await this.walk(path.posix.join(root, d))));
    }
    return out;
  }

  /**
   * Close the underlying socket
   */
  close(): void {
    log.debug('Closing AFC service connection');
    try {
      this.socket?.end();
    } catch (error) {
      log.debug('Error while closing socket (ignored):', error);
    }
    this.socket = null;
  }

  /**
   * Connect to RSD port and perform RSDCheckin.
   * Keeps the underlying socket for raw AFC I/O.
   */
  private async _connect(): Promise<net.Socket> {
    if (this.socket && !this.socket.destroyed) {
      return this.socket;
    }
    const [host, rsdPort] = this.address;

    this.socket = await new Promise<net.Socket>((resolve, reject) => {
      const s = net.createConnection({ host, port: rsdPort }, () => {
        s.setTimeout(0);
        s.setKeepAlive(true);
        resolve(s);
      });
      s.once('error', reject);
      s.setTimeout(30000, () => {
        s.destroy();
        reject(new Error('AFC connect timed out'));
      });
    });

    await rsdHandshakeForRawService(this.socket);
    log.debug('RSD handshake complete; switching to raw AFC');

    return this.socket;
  }

  private async _resolvePath(filePath: string): Promise<string> {
    const info = await this.stat(filePath);
    if (info.st_ifmt === 'S_IFLNK' && info.LinkTarget) {
      const target = info.LinkTarget;
      if (target.startsWith('/')) {
        return target;
      }
      return path.posix.join(path.posix.dirname(filePath), target);
    }
    return filePath;
  }

  private async _dispatch(
    op: AfcOpcode,
    payload: Buffer = Buffer.alloc(0),
    thisLenOverride?: number,
  ): Promise<void> {
    const sock = await this._connect();
    const cur = this.packetNum;
    await sendAfcPacket(sock, op, cur, payload, thisLenOverride);
    this.packetNum = cur + 1n;
  }

  private async _receive(): Promise<{ status: AfcError; data: Buffer }> {
    const sock = await this._connect();
    const res = await readAfcResponse(sock);
    return { status: res.status, data: res.data };
  }

  /**
   * Send a single-operation request and parse result.
   * Throws if status != SUCCESS.
   * Returns response DATA buffer when applicable.
   */
  private async _doOperation(
    op: AfcOpcode,
    payload: Buffer = Buffer.alloc(0),
    thisLenOverride?: number,
  ): Promise<Buffer> {
    await this._dispatch(op, payload, thisLenOverride);
    const { status, data } = await this._receive();

    if (status !== AfcError.SUCCESS) {
      const errorName = AfcError[status] || 'UNKNOWN';
      const opName = AfcOpcode[op] || op.toString();

      if (status === AfcError.OBJECT_NOT_FOUND) {
        throw new Error(`AFC error: OBJECT_NOT_FOUND for operation ${opName}`);
      }

      log.error(
        `AFC operation ${opName} failed with status ${errorName} (${status})`,
      );
      throw new Error(
        `AFC operation ${opName} failed with ${errorName} (${status})`,
      );
    }
    return data;
  }
}

export default AfcService;
