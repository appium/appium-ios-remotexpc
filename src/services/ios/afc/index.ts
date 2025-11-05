import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { getLogger } from '../../../lib/logger.js';
import {
  buildClosePayload,
  buildFopenPayload,
  buildReadPayload,
  buildRemovePayload,
  buildRenamePayload,
  buildStatPayload,
  nanosecondsToMilliseconds,
  nextReadChunkSize,
  parseCStringArray,
  parseKeyValueNullList,
  readAfcResponse,
  rsdHandshakeForRawService,
  sendAfcPacket,
  writeUInt64LE,
} from './codec.js';
import { AFC_FOPEN_TEXTUAL_MODES, AFC_WRITE_THIS_LENGTH } from './constants.js';
import { AfcError, AfcFileMode, AfcOpcode } from './enums.js';
import { createAfcReadStream, createAfcWriteStream } from './stream-utils.js';

const log = getLogger('AfcService');

const NON_LISTABLE_ENTRIES = ['', '.', '..'];

export interface StatInfo {
  st_ifmt: AfcFileMode;
  st_size: bigint;
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
  static readonly RSD_SERVICE_NAME = 'com.apple.afc.shim.remote';

  private socket: net.Socket | null = null;
  private packetNum: bigint = 0n;
  private silent: boolean = false;

  constructor(
    private readonly address: [string, number],
    silent?: boolean,
  ) {
    this.silent = silent ?? process.env.NODE_ENV !== 'test';
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
    return entries.filter((x) => !NON_LISTABLE_ENTRIES.includes(x));
  }

  async stat(filePath: string): Promise<StatInfo> {
    log.debug(`Getting file info for: ${filePath}`);
    try {
      const data = await this._doOperation(
        AfcOpcode.GET_FILE_INFO,
        buildStatPayload(filePath),
      );
      const kv = parseKeyValueNullList(data);

      const out: StatInfo = {
        st_size: BigInt(kv.st_size),
        st_blocks: Number.parseInt(kv.st_blocks, 10),
        st_mtime: new Date(nanosecondsToMilliseconds(kv.st_mtime)),
        st_birthtime: new Date(nanosecondsToMilliseconds(kv.st_birthtime)),
        st_nlink: Number.parseInt(kv.st_nlink, 10),
      } as StatInfo;
      for (const [k, v] of Object.entries(kv)) {
        if (!(k in out)) {
          (out as any)[k] = v;
        }
      }
      return out;
    } catch (error) {
      if (!this.silent) {
        log.error(`Failed to stat file '${filePath}':`, error);
      }
      throw error;
    }
  }

  async isdir(filePath: string): Promise<boolean> {
    const st = await this.stat(filePath);
    return st.st_ifmt === AfcFileMode.S_IFDIR;
  }

  async exists(filePath: string): Promise<boolean> {
    try {
      await this.stat(filePath);
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
    if (!afcMode) {
      const allowedModes = Object.keys(AFC_FOPEN_TEXTUAL_MODES).join(', ');
      if (!this.silent) {
        log.error(
          `Invalid fopen mode '${mode}'. Allowed modes: ${allowedModes}`,
        );
      }
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
      if (!this.silent) {
        log.error(
          `Failed to open file '${filePath}' with mode '${mode}':`,
          error,
        );
      }
      throw error;
    }
  }

  async fclose(handle: bigint): Promise<void> {
    await this._doOperation(AfcOpcode.FILE_CLOSE, buildClosePayload(handle));
  }

  createReadStream(handle: bigint, size: bigint): Readable {
    return createAfcReadStream(
      handle,
      size,
      this._dispatch.bind(this),
      this._receive.bind(this),
    );
  }

  createWriteStream(handle: bigint, chunkSize?: number): Writable {
    return createAfcWriteStream(
      handle,
      this._dispatch.bind(this),
      this._receive.bind(this),
      chunkSize,
    );
  }

  async fread(handle: bigint, size: bigint): Promise<Buffer> {
    log.debug(`Reading ${size} bytes from handle ${handle}`);
    const stream = this.createReadStream(handle, size);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);
    log.debug(`Successfully read ${buffer.length} bytes`);
    return buffer;
  }

  async fwrite(
    handle: bigint,
    data: Buffer,
    chunkSize = data.length,
  ): Promise<void> {
    log.debug(`Writing ${data.length} bytes to handle ${handle}`);
    const effectiveChunkSize = chunkSize;
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
        if (!this.silent) {
          log.error(
            `Write operation failed at offset ${offset} with status ${errorName} (${status})`,
          );
        }
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
    if (st.st_ifmt !== AfcFileMode.S_IFREG) {
      if (!this.silent) {
        log.error(
          `Path '${resolved}' is not a regular file (type: ${st.st_ifmt})`,
        );
      }
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
    } catch (error) {
      await this.rmSingle(filePath, true);
      throw error;
    } finally {
      await this.fclose(h);
    }
  }

  async readToStream(filePath: string): Promise<Readable> {
    log.debug(`Creating read stream for: ${filePath}`);
    const resolved = await this._resolvePath(filePath);
    const st = await this.stat(resolved);
    if (st.st_ifmt !== AfcFileMode.S_IFREG) {
      throw new Error(`'${resolved}' isn't a regular file`);
    }
    const handle = await this.fopen(resolved, 'r');
    const stream = this.createReadStream(handle, st.st_size);
    stream.once('close', () => this.fclose(handle).catch(() => {}));
    return stream;
  }

  async writeFromStream(filePath: string, stream: Readable): Promise<void> {
    log.debug(`Writing stream to file: ${filePath}`);
    const handle = await this.fopen(filePath, 'w');
    const writeStream = this.createWriteStream(handle);
    try {
      await pipeline(stream, writeStream);
      log.debug(`Successfully wrote file: ${filePath}`);
    } catch (error) {
      await this.rmSingle(filePath, true);
      throw error;
    } finally {
      await this.fclose(handle);
    }
  }

  async pull(remoteSrc: string, localDst: string): Promise<void> {
    log.debug(`Pulling file from '${remoteSrc}' to '${localDst}'`);
    const stream = await this.readToStream(remoteSrc);
    const writeStream = fs.createWriteStream(localDst);
    await pipeline(stream, writeStream);
    log.debug(`Successfully pulled file to '${localDst}'`);
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
      if (!this.silent) {
        log.error(`Failed to remove '${filePath}':`, error);
      }
      throw error;
    }
  }

  async rm(filePath: string, force = false): Promise<string[]> {
    if (!(await this.exists(filePath))) {
      return force ? [] : [filePath];
    }

    if (!(await this.isdir(filePath))) {
      if (await this.rmSingle(filePath, force)) {
        return [];
      }
      return [filePath];
    }

    const failedPaths: string[] = [];
    for (const entry of await this.listdir(filePath)) {
      const cur = path.posix.join(filePath, entry);
      if (await this.isdir(cur)) {
        const sub = await this.rm(cur, true);
        failedPaths.push(...sub);
      } else {
        if (!(await this.rmSingle(cur, true))) {
          failedPaths.push(cur);
        }
      }
    }

    try {
      if (!(await this.rmSingle(filePath, force))) {
        failedPaths.push(filePath);
      }
    } catch (err) {
      if (failedPaths.length) {
        failedPaths.push(filePath);
      } else {
        throw err;
      }
    }

    return failedPaths;
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
      if (!this.silent) {
        log.error(`Failed to rename '${src}' to '${dst}':`, error);
      }
      throw error;
    }
  }

  async push(localSrc: string, remoteDst: string): Promise<void> {
    log.debug(`Pushing file from '${localSrc}' to '${remoteDst}'`);
    const readStream = fs.createReadStream(localSrc);
    await this.writeFromStream(remoteDst, readStream);
    log.debug(`Successfully pushed file to '${remoteDst}'`);
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
    if (info.st_ifmt === AfcFileMode.S_IFLNK && info.LinkTarget) {
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
    await sendAfcPacket(sock, op, this.packetNum++, payload, thisLenOverride);
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

      if (!this.silent) {
        log.error(
          `AFC operation ${opName} failed with status ${errorName} (${status})`,
        );
      }
      throw new Error(
        `AFC operation ${opName} failed with ${errorName} (${status})`,
      );
    }
    return data;
  }
}

export default AfcService;
