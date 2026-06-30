/**
 * @license node-stream-zip | (c) 2020 Antelle | https://github.com/antelle/node-stream-zip/blob/master/LICENSE
 * Portions copyright https://github.com/cthackers/adm-zip | https://raw.githubusercontent.com/cthackers/adm-zip/master/LICENSE
 *
 * Vendored from node-stream-zip@1.15.0, trimmed to the archive-reading paths
 * used by ZipConduit (central-directory listing + streaming entry reads).
 * Removed unused features: extract-to-disk, synchronous entry data, setFs,
 * and the async helpers entriesCount/comment/entry/entryData/extract.
 */
import {EventEmitter} from 'node:events';
import fs from 'node:fs';
import stream from 'node:stream';
import zlib from 'node:zlib';

export interface StreamZipConfig {
  file?: string;
  fd?: number;
  chunkSize?: number;
  storeEntries?: boolean;
  skipEntryNameValidation?: boolean;
  nameEncoding?: string;
  /**
   * When true, skip local header reads for STORED entries (IPAs use STORE).
   * Deflated entries always read the local header for a correct data offset.
   */
  skipLocalHeaderRead?: boolean;
  /** When false, skip CRC32 verification while streaming (faster; default verifies). */
  verifyEntryCrc?: boolean;
}

export type StreamZipEntry = ZipEntry;

interface SignatureSearchState {
  win: FileWindowBuffer;
  totalReadLength: number;
  minPos: number;
  lastPos: number;
  chunkSize: number;
  firstByte: number;
  sig: number;
  lastBufferPosition: number;
  lastBytesRead: number;
  complete: () => void;
}

interface EntriesReadState {
  win: FileWindowBuffer;
  pos: number;
  chunkSize: number;
  entriesLeft: number;
  entry: ZipEntry | null;
  move?: boolean;
}

type FsReadCallback = (err: NodeJS.ErrnoException | null, bytesRead?: number) => void;

const ZIP = {
  LOCHDR: 30,
  LOCSIG: 0x04034b50,
  LOCVER: 4,
  LOCFLG: 6,
  LOCHOW: 8,
  LOCTIM: 10,
  LOCCRC: 14,
  LOCSIZ: 18,
  LOCLEN: 22,
  LOCNAM: 26,
  LOCEXT: 28,
  CENHDR: 46,
  CENSIG: 0x02014b50,
  CENVEM: 4,
  CENVER: 6,
  CENFLG: 8,
  CENHOW: 10,
  CENTIM: 12,
  CENCRC: 16,
  CENSIZ: 20,
  CENLEN: 24,
  CENNAM: 28,
  CENEXT: 30,
  CENCOM: 32,
  CENDSK: 34,
  CENATT: 36,
  CENATX: 38,
  CENOFF: 42,
  ENDHDR: 22,
  ENDSIG: 0x06054b50,
  ENDSIGFIRST: 0x50,
  ENDSUB: 8,
  ENDTOT: 10,
  ENDSIZ: 12,
  ENDOFF: 16,
  ENDCOM: 20,
  MAXFILECOMMENT: 0xffff,
  ENDL64HDR: 20,
  ENDL64SIG: 0x07064b50,
  ENDL64SIGFIRST: 0x50,
  END64HDR: 56,
  END64SIG: 0x06064b50,
  END64SIGFIRST: 0x50,
  END64SUB: 24,
  END64TOT: 32,
  END64SIZ: 40,
  END64OFF: 48,
  STORED: 0,
  DEFLATED: 8,
  FLG_ENTRY_ENC: 1,
  ID_ZIP64: 0x0001,
  EF_ZIP64_OR_32: 0xffffffff,
  EF_ZIP64_OR_16: 0xffff,
} as const;

class CentralDirectoryHeader {
  volumeEntries = 0;
  totalEntries = 0;
  size = 0;
  offset = 0;
  commentLength = 0;
  headerOffset = 0;

  read(data: Buffer): void {
    if (data.length !== ZIP.ENDHDR || data.readUInt32LE(0) !== ZIP.ENDSIG) {
      throw new Error('Invalid central directory');
    }
    this.volumeEntries = data.readUInt16LE(ZIP.ENDSUB);
    this.totalEntries = data.readUInt16LE(ZIP.ENDTOT);
    this.size = data.readUInt32LE(ZIP.ENDSIZ);
    this.offset = data.readUInt32LE(ZIP.ENDOFF);
    this.commentLength = data.readUInt16LE(ZIP.ENDCOM);
  }
}

class CentralDirectoryLoc64Header {
  headerOffset = 0;

  read(data: Buffer): void {
    if (data.length !== ZIP.ENDL64HDR || data.readUInt32LE(0) !== ZIP.ENDL64SIG) {
      throw new Error('Invalid zip64 central directory locator');
    }
    this.headerOffset = readUInt64LE(data, ZIP.ENDSUB);
  }
}

class CentralDirectoryZip64Header {
  volumeEntries = 0;
  totalEntries = 0;
  size = 0;
  offset = 0;

  read(data: Buffer): void {
    if (data.length !== ZIP.END64HDR || data.readUInt32LE(0) !== ZIP.END64SIG) {
      throw new Error('Invalid central directory');
    }
    this.volumeEntries = readUInt64LE(data, ZIP.END64SUB);
    this.totalEntries = readUInt64LE(data, ZIP.END64TOT);
    this.size = readUInt64LE(data, ZIP.END64SIZ);
    this.offset = readUInt64LE(data, ZIP.END64OFF);
  }
}

class FsRead {
  bytesRead = 0;
  waiting = false;

  constructor(
    private readonly fd: number,
    private readonly buffer: Buffer,
    private readonly offset: number,
    private readonly length: number,
    private readonly position: number,
    private readonly callback: FsReadCallback,
  ) {}

  read(sync = false): this {
    this.waiting = true;
    if (sync) {
      let err: NodeJS.ErrnoException | undefined;
      let bytesRead = 0;
      try {
        bytesRead = fs.readSync(
          this.fd,
          this.buffer,
          this.offset + this.bytesRead,
          this.length - this.bytesRead,
          this.position + this.bytesRead,
        );
      } catch (e) {
        err = e as NodeJS.ErrnoException;
      }
      this.readCallback(sync, err ?? null, err ? bytesRead : null);
    } else {
      fs.read(
        this.fd,
        this.buffer,
        this.offset + this.bytesRead,
        this.length - this.bytesRead,
        this.position + this.bytesRead,
        (err, bytesRead) => this.readCallback(sync, err, bytesRead),
      );
    }
    return this;
  }

  private readCallback(sync: boolean, err: NodeJS.ErrnoException | null, bytesRead: number | null): void {
    if (typeof bytesRead === 'number') {
      this.bytesRead += bytesRead;
    }
    if (err || !bytesRead || this.bytesRead === this.length) {
      this.waiting = false;
      this.callback(err, this.bytesRead);
      return;
    }
    this.read(sync);
  }
}

class FileWindowBuffer {
  position = 0;
  buffer = Buffer.alloc(0);
  fsOp: FsRead | null = null;

  constructor(private readonly fd: number) {}

  read(pos: number, length: number, callback: FsReadCallback): void {
    this.checkOp();
    if (this.buffer.length < length) {
      this.buffer = Buffer.alloc(length);
    }
    this.position = pos;
    this.fsOp = new FsRead(this.fd, this.buffer, 0, length, this.position, callback);
    this.fsOp.read();
  }

  expandLeft(length: number, callback: FsReadCallback): void {
    this.checkOp();
    this.buffer = Buffer.concat([Buffer.alloc(length), this.buffer]);
    this.position -= length;
    if (this.position < 0) {
      this.position = 0;
    }
    this.fsOp = new FsRead(this.fd, this.buffer, 0, length, this.position, callback);
    this.fsOp.read();
  }

  expandRight(length: number, callback: FsReadCallback): void {
    this.checkOp();
    const offset = this.buffer.length;
    this.buffer = Buffer.concat([this.buffer, Buffer.alloc(length)]);
    this.fsOp = new FsRead(this.fd, this.buffer, offset, length, this.position + offset, callback);
    this.fsOp.read();
  }

  moveRight(length: number, callback: FsReadCallback, shift = 0): void {
    this.checkOp();
    if (shift) {
      this.buffer.copy(this.buffer, 0, shift);
    }
    this.position += shift;
    this.fsOp = new FsRead(
      this.fd,
      this.buffer,
      this.buffer.length - shift,
      shift,
      this.position + this.buffer.length - shift,
      callback,
    );
    this.fsOp.read();
  }

  private checkOp(): void {
    if (this.fsOp?.waiting) {
      throw new Error('Operation in progress');
    }
  }
}

class EntryDataReaderStream extends stream.Readable {
  private pos = 0;

  constructor(
    private readonly fd: number,
    private readonly dataOffset: number,
    private readonly length: number,
    private readonly readChunkSize: number,
  ) {
    super({highWaterMark: readChunkSize});
  }

  override _read(): void {
    const toRead = Math.min(this.readChunkSize, this.length - this.pos);
    const buffer = Buffer.allocUnsafe(toRead);
    if (buffer.length) {
      fs.read(this.fd, buffer, 0, buffer.length, this.dataOffset + this.pos, (err, bytesRead) =>
        this.onRead(err, bytesRead, buffer),
      );
    } else {
      this.push(null);
    }
  }

  private onRead(err: NodeJS.ErrnoException | null, bytesRead: number, buffer: Buffer): void {
    this.pos += bytesRead;
    if (err) {
      this.emit('error', err);
      this.push(null);
      return;
    }
    if (!bytesRead) {
      this.push(null);
      return;
    }
    this.push(bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead));
  }
}

class CrcVerify {
  private static crcTable: number[] | undefined;

  private readonly state = {crc: ~0, size: 0};

  constructor(
    private readonly expectedCrc: number,
    private readonly expectedSize: number,
  ) {}

  data(data: Buffer): void {
    const crcTable = CrcVerify.getCrcTable();
    let crc = this.state.crc;
    let off = 0;
    let len = data.length;
    while (--len >= 0) {
      crc = crcTable[(crc ^ data[off++]) & 0xff] ^ (crc >>> 8);
    }
    this.state.crc = crc;
    this.state.size += data.length;
    if (this.state.size >= this.expectedSize) {
      const buf = Buffer.alloc(4);
      buf.writeInt32LE(~this.state.crc & 0xffffffff, 0);
      crc = buf.readUInt32LE(0);
      if (crc !== this.expectedCrc) {
        throw new Error('Invalid CRC');
      }
      if (this.state.size !== this.expectedSize) {
        throw new Error('Invalid size');
      }
    }
  }

  private static getCrcTable(): number[] {
    if (CrcVerify.crcTable) {
      return CrcVerify.crcTable;
    }
    const crcTable: number[] = [];
    const b = Buffer.alloc(4);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 7; k >= 0; k--) {
        c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      if (c < 0) {
        b.writeInt32LE(c, 0);
        c = b.readUInt32LE(0);
      }
      crcTable[n] = c;
    }
    CrcVerify.crcTable = crcTable;
    return crcTable;
  }
}

class EntryVerifyStream extends stream.Transform {
  private readonly verify: CrcVerify;

  constructor(baseStm: stream.Readable, crc: number, size: number) {
    super();
    this.verify = new CrcVerify(crc, size);
    baseStm.on('error', (e) => this.emit('error', e));
  }

  override _transform(data: Buffer, _encoding: BufferEncoding, callback: stream.TransformCallback): void {
    let err: Error | undefined;
    try {
      this.verify.data(data);
    } catch (e) {
      err = e as Error;
    }
    callback(err, data);
  }
}

/** ZIP central-directory entry (also returned from {@link StreamZip.entries}). */
export class ZipEntry {
  verMade = 0;
  version = 0;
  flags = 0;
  method = 0;
  time = 0;
  crc = 0;
  compressedSize = 0;
  size = 0;
  fnameLen = 0;
  extraLen = 0;
  comLen = 0;
  diskStart = 0;
  inattr = 0;
  attr = 0;
  offset = 0;
  headerOffset = 0;
  name = '';
  isDirectory = false;
  comment: string | null = null;

  readHeader(data: Buffer, offset: number): void {
    if (data.length < offset + ZIP.CENHDR || data.readUInt32LE(offset) !== ZIP.CENSIG) {
      throw new Error('Invalid entry header');
    }
    this.verMade = data.readUInt16LE(offset + ZIP.CENVEM);
    this.version = data.readUInt16LE(offset + ZIP.CENVER);
    this.flags = data.readUInt16LE(offset + ZIP.CENFLG);
    this.method = data.readUInt16LE(offset + ZIP.CENHOW);
    const timebytes = data.readUInt16LE(offset + ZIP.CENTIM);
    const datebytes = data.readUInt16LE(offset + ZIP.CENTIM + 2);
    this.time = parseZipTime(timebytes, datebytes);
    this.crc = data.readUInt32LE(offset + ZIP.CENCRC);
    this.compressedSize = data.readUInt32LE(offset + ZIP.CENSIZ);
    this.size = data.readUInt32LE(offset + ZIP.CENLEN);
    this.fnameLen = data.readUInt16LE(offset + ZIP.CENNAM);
    this.extraLen = data.readUInt16LE(offset + ZIP.CENEXT);
    this.comLen = data.readUInt16LE(offset + ZIP.CENCOM);
    this.diskStart = data.readUInt16LE(offset + ZIP.CENDSK);
    this.inattr = data.readUInt16LE(offset + ZIP.CENATT);
    this.attr = data.readUInt32LE(offset + ZIP.CENATX);
    this.offset = data.readUInt32LE(offset + ZIP.CENOFF);
  }

  readDataHeader(data: Buffer): void {
    if (data.readUInt32LE(0) !== ZIP.LOCSIG) {
      throw new Error('Invalid local header');
    }
    this.version = data.readUInt16LE(ZIP.LOCVER);
    this.flags = data.readUInt16LE(ZIP.LOCFLG);
    this.method = data.readUInt16LE(ZIP.LOCHOW);
    const timebytes = data.readUInt16LE(ZIP.LOCTIM);
    const datebytes = data.readUInt16LE(ZIP.LOCTIM + 2);
    this.time = parseZipTime(timebytes, datebytes);
    this.crc = data.readUInt32LE(ZIP.LOCCRC) || this.crc;
    const compressedSize = data.readUInt32LE(ZIP.LOCSIZ);
    if (compressedSize && compressedSize !== ZIP.EF_ZIP64_OR_32) {
      this.compressedSize = compressedSize;
    }
    const size = data.readUInt32LE(ZIP.LOCLEN);
    if (size && size !== ZIP.EF_ZIP64_OR_32) {
      this.size = size;
    }
    this.fnameLen = data.readUInt16LE(ZIP.LOCNAM);
    this.extraLen = data.readUInt16LE(ZIP.LOCEXT);
  }

  read(data: Buffer, offset: number, textDecoder: TextDecoder | null): void {
    const nameData = data.slice(offset, (offset += this.fnameLen));
    this.name = textDecoder ? textDecoder.decode(new Uint8Array(nameData)) : nameData.toString('utf8');
    const lastChar = data[offset - 1];
    this.isDirectory = lastChar === 47 || lastChar === 92;
    if (this.extraLen) {
      this.readExtra(data, offset);
      offset += this.extraLen;
    }
    this.comment = this.comLen ? data.slice(offset, offset + this.comLen).toString() : null;
  }

  validateName(): void {
    if (/\\|^\w+:|^\/|(^|\/)\.\.(\/|$)/.test(this.name)) {
      throw new Error(`Malicious entry: ${this.name}`);
    }
  }

  readExtra(data: Buffer, offset: number): void {
    const maxPos = offset + this.extraLen;
    while (offset < maxPos) {
      const signature = data.readUInt16LE(offset);
      offset += 2;
      const size = data.readUInt16LE(offset);
      offset += 2;
      if (ZIP.ID_ZIP64 === signature) {
        this.parseZip64Extra(data, offset, size);
      }
      offset += size;
    }
  }

  parseZip64Extra(data: Buffer, offset: number, length: number): void {
    if (length >= 8 && this.size === ZIP.EF_ZIP64_OR_32) {
      this.size = readUInt64LE(data, offset);
      offset += 8;
      length -= 8;
    }
    if (length >= 8 && this.compressedSize === ZIP.EF_ZIP64_OR_32) {
      this.compressedSize = readUInt64LE(data, offset);
      offset += 8;
      length -= 8;
    }
    if (length >= 8 && this.offset === ZIP.EF_ZIP64_OR_32) {
      this.offset = readUInt64LE(data, offset);
      offset += 8;
      length -= 8;
    }
    if (length >= 4 && this.diskStart === ZIP.EF_ZIP64_OR_16) {
      this.diskStart = data.readUInt32LE(offset);
    }
  }

  get encrypted(): boolean {
    return (this.flags & ZIP.FLG_ENTRY_ENC) === ZIP.FLG_ENTRY_ENC;
  }

  get isFile(): boolean {
    return !this.isDirectory;
  }
}

/** Streaming ZIP reader with promise-based entry access. */
export class StreamZip extends EventEmitter {
  entriesCount = 0;
  comment: string | null = null;
  centralDirectory!: CentralDirectoryHeader;

  private fd: number | null = null;
  private fileSize = 0;
  private chunkSize = 0;
  private closed = false;
  private signatureOp: SignatureSearchState | null = null;
  private entriesOp: EntriesReadState | null = null;
  private readonly entryMap: Record<string, ZipEntry> | null;
  private readonly textDecoder: TextDecoder | null;
  private readonly readyPromise: Promise<void>;

  constructor(private readonly config: StreamZipConfig) {
    super();
    this.entryMap = config.storeEntries !== false ? {} : null;
    this.textDecoder = config.nameEncoding ? new TextDecoder(config.nameEncoding) : null;
    this.readyPromise = new Promise((resolve, reject) => {
      this.once('ready', () => {
        this.removeListener('error', reject);
        resolve();
      });
      this.once('error', reject);
    });
    this.open();
  }

  /** Resolves when the central directory has been parsed. */
  async waitUntilReady(): Promise<void> {
    await this.readyPromise;
  }

  async entries(): Promise<Record<string, ZipEntry>> {
    await this.readyPromise;
    const entryMap = this.entryMap;
    if (!entryMap) {
      throw new Error('storeEntries disabled');
    }
    return entryMap;
  }

  async stream(entry: ZipEntry | string): Promise<stream.Readable> {
    await this.readyPromise;
    const resolvedEntry = await this.resolveFileEntry(entry);
    const openedEntry =
      this.config.skipLocalHeaderRead === true && resolvedEntry.method === ZIP.STORED
        ? resolvedEntry
        : await this.openEntry(resolvedEntry);
    if (openedEntry.encrypted) {
      throw new Error('Entry encrypted');
    }
    const offset = this.dataOffset(openedEntry);
    if (this.fd === null) {
      throw new Error('Archive closed');
    }
    let entryStream: stream.Readable = new EntryDataReaderStream(
      this.fd,
      offset,
      openedEntry.compressedSize,
      this.chunkSize || 1024 * 1024,
    );
    if (openedEntry.method === ZIP.STORED) {
      // stored — pass through
    } else if (openedEntry.method === ZIP.DEFLATED) {
      entryStream = entryStream.pipe(zlib.createInflateRaw());
    } else {
      throw new Error(`Unknown compression method: ${openedEntry.method}`);
    }
    if (this.config.verifyEntryCrc !== false && this.canVerifyCrc(openedEntry)) {
      entryStream = entryStream.pipe(new EntryVerifyStream(entryStream, openedEntry.crc, openedEntry.size));
    }
    return entryStream;
  }

  async openEntry(entry: ZipEntry | string): Promise<ZipEntry> {
    await this.readyPromise;
    let resolvedEntry: ZipEntry | undefined;
    if (typeof entry === 'string') {
      const entryMap = this.entryMap;
      if (!entryMap) {
        throw new Error('storeEntries disabled');
      }
      resolvedEntry = entryMap[entry];
      if (!resolvedEntry) {
        throw new Error('Entry not found');
      }
    } else {
      resolvedEntry = entry;
    }
    if (!resolvedEntry.isFile) {
      throw new Error('Entry is not file');
    }
    const fd = this.fd;
    if (fd === null) {
      throw new Error('Archive closed');
    }
    const entryOffset = resolvedEntry.offset;
    const buffer = Buffer.alloc(ZIP.LOCHDR);
    await new Promise<void>((resolve, reject) => {
      new FsRead(fd, buffer, 0, buffer.length, entryOffset, (err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      }).read();
    });
    resolvedEntry.readDataHeader(buffer);
    if (resolvedEntry.encrypted) {
      throw new Error('Entry encrypted');
    }
    return resolvedEntry;
  }

  async close(): Promise<void> {
    if (this.closed || this.fd === null) {
      this.closed = true;
      return;
    }
    this.closed = true;
    const fd = this.fd;
    this.fd = null;
    await new Promise<void>((resolve, reject) => {
      fs.close(fd, (err) => (err ? reject(err) : resolve()));
    });
  }

  override emit(event: string | symbol, ...args: unknown[]): boolean {
    if (this.closed) {
      return false;
    }
    return super.emit(event, ...args);
  }

  private async resolveFileEntry(entry: ZipEntry | string): Promise<ZipEntry> {
    if (typeof entry === 'string') {
      const entryMap = this.entryMap;
      if (!entryMap) {
        throw new Error('storeEntries disabled');
      }
      const resolvedEntry = entryMap[entry];
      if (!resolvedEntry) {
        throw new Error('Entry not found');
      }
      if (!resolvedEntry.isFile) {
        throw new Error('Entry is not file');
      }
      return resolvedEntry;
    }
    if (!entry.isFile) {
      throw new Error('Entry is not file');
    }
    return entry;
  }

  private open(): void {
    if (this.config.fd !== undefined) {
      this.fd = this.config.fd;
      this.readFile();
      return;
    }
    const filePath = this.config.file;
    if (!filePath) {
      this.emit('error', new Error('ZIP file path is required'));
      return;
    }
    fs.open(filePath, 'r', (err, f) => {
      if (err) {
        this.emit('error', err);
        return;
      }
      this.fd = f;
      this.readFile();
    });
  }

  private readFile(): void {
    if (this.fd === null) {
      return;
    }
    fs.fstat(this.fd, (err, stat) => {
      if (err) {
        this.emit('error', err);
        return;
      }
      this.fileSize = stat.size;
      let chunk = this.config.chunkSize ?? Math.round(this.fileSize / 1000);
      chunk = Math.max(Math.min(chunk, Math.min(128 * 1024, this.fileSize)), Math.min(1024, this.fileSize));
      this.chunkSize = chunk;
      this.readCentralDirectory();
    });
  }

  private readUntilFoundCallback: FsReadCallback = (err, bytesRead) => {
    const op = this.signatureOp;
    if (!op) {
      return;
    }
    if (err || !bytesRead) {
      this.emit('error', err ?? new Error('Archive read error'));
      return;
    }
    let pos = op.lastPos;
    let bufferPosition = pos - op.win.position;
    const buffer = op.win.buffer;
    const minPos = op.minPos;
    while (--pos >= minPos && --bufferPosition >= 0) {
      if (buffer.length - bufferPosition >= 4 && buffer[bufferPosition] === op.firstByte) {
        if (buffer.readUInt32LE(bufferPosition) === op.sig) {
          op.lastBufferPosition = bufferPosition;
          op.lastBytesRead = bytesRead;
          op.complete();
          return;
        }
      }
    }
    if (pos === minPos) {
      this.emit('error', new Error('Bad archive'));
      return;
    }
    op.lastPos = pos + 1;
    op.chunkSize *= 2;
    if (pos <= minPos) {
      this.emit('error', new Error('Bad archive'));
      return;
    }
    const expandLength = Math.min(op.chunkSize, pos - minPos);
    op.win.expandLeft(expandLength, this.readUntilFoundCallback);
  };

  private readCentralDirectory(): void {
    if (this.fd === null) {
      return;
    }
    const totalReadLength = Math.min(ZIP.ENDHDR + ZIP.MAXFILECOMMENT, this.fileSize);
    this.signatureOp = {
      win: new FileWindowBuffer(this.fd),
      totalReadLength,
      minPos: this.fileSize - totalReadLength,
      lastPos: this.fileSize,
      chunkSize: Math.min(1024, this.chunkSize),
      firstByte: ZIP.ENDSIGFIRST,
      sig: ZIP.ENDSIG,
      lastBufferPosition: 0,
      lastBytesRead: 0,
      complete: () => this.readCentralDirectoryComplete(),
    };
    const op = this.signatureOp;
    op.win.read(this.fileSize - op.chunkSize, op.chunkSize, this.readUntilFoundCallback);
  }

  private readCentralDirectoryComplete(): void {
    const op = this.signatureOp;
    if (!op) {
      return;
    }
    const buffer = op.win.buffer;
    const pos = op.lastBufferPosition;
    try {
      const centralDirectory = new CentralDirectoryHeader();
      centralDirectory.read(buffer.subarray(pos, pos + ZIP.ENDHDR));
      centralDirectory.headerOffset = op.win.position + pos;
      if (centralDirectory.commentLength) {
        this.comment = buffer.subarray(pos + ZIP.ENDHDR, pos + ZIP.ENDHDR + centralDirectory.commentLength).toString();
      } else {
        this.comment = null;
      }
      this.entriesCount = centralDirectory.volumeEntries;
      this.centralDirectory = centralDirectory;
      if (
        (centralDirectory.volumeEntries === ZIP.EF_ZIP64_OR_16 &&
          centralDirectory.totalEntries === ZIP.EF_ZIP64_OR_16) ||
        centralDirectory.size === ZIP.EF_ZIP64_OR_32 ||
        centralDirectory.offset === ZIP.EF_ZIP64_OR_32
      ) {
        this.readZip64CentralDirectoryLocator();
      } else {
        this.signatureOp = null;
        this.readEntries();
      }
    } catch (err) {
      this.emit('error', err);
    }
  }

  private readZip64CentralDirectoryLocator(): void {
    const op = this.signatureOp;
    if (!op) {
      return;
    }
    const length = ZIP.ENDL64HDR;
    if (op.lastBufferPosition > length) {
      op.lastBufferPosition -= length;
      this.readZip64CentralDirectoryLocatorComplete();
      return;
    }
    this.signatureOp = {
      win: op.win,
      totalReadLength: length,
      minPos: op.win.position - length,
      lastPos: op.win.position,
      chunkSize: op.chunkSize,
      firstByte: ZIP.ENDL64SIGFIRST,
      sig: ZIP.ENDL64SIG,
      lastBufferPosition: op.lastBufferPosition,
      lastBytesRead: op.lastBytesRead,
      complete: () => this.readZip64CentralDirectoryLocatorComplete(),
    };
    const next = this.signatureOp;
    next.win.read(next.lastPos - next.chunkSize, next.chunkSize, this.readUntilFoundCallback);
  }

  private readZip64CentralDirectoryLocatorComplete(): void {
    const op = this.signatureOp;
    if (!op) {
      return;
    }
    const buffer = op.win.buffer;
    const locHeader = new CentralDirectoryLoc64Header();
    locHeader.read(buffer.subarray(op.lastBufferPosition, op.lastBufferPosition + ZIP.ENDL64HDR));
    const readLength = this.fileSize - locHeader.headerOffset;
    this.signatureOp = {
      win: op.win,
      totalReadLength: readLength,
      minPos: locHeader.headerOffset,
      lastPos: op.lastPos,
      chunkSize: op.chunkSize,
      firstByte: ZIP.END64SIGFIRST,
      sig: ZIP.END64SIG,
      lastBufferPosition: op.lastBufferPosition,
      lastBytesRead: op.lastBytesRead,
      complete: () => this.readZip64CentralDirectoryComplete(),
    };
    const next = this.signatureOp;
    next.win.read(this.fileSize - next.chunkSize, next.chunkSize, this.readUntilFoundCallback);
  }

  private readZip64CentralDirectoryComplete(): void {
    const op = this.signatureOp;
    if (!op) {
      return;
    }
    const buffer = op.win.buffer;
    const zip64cd = new CentralDirectoryZip64Header();
    zip64cd.read(buffer.subarray(op.lastBufferPosition, op.lastBufferPosition + ZIP.END64HDR));
    this.centralDirectory.volumeEntries = zip64cd.volumeEntries;
    this.centralDirectory.totalEntries = zip64cd.totalEntries;
    this.centralDirectory.size = zip64cd.size;
    this.centralDirectory.offset = zip64cd.offset;
    this.entriesCount = zip64cd.volumeEntries;
    this.signatureOp = null;
    this.readEntries();
  }

  private readEntries(): void {
    if (this.fd === null) {
      return;
    }
    this.entriesOp = {
      win: new FileWindowBuffer(this.fd),
      pos: this.centralDirectory.offset,
      chunkSize: this.chunkSize,
      entriesLeft: this.centralDirectory.volumeEntries,
      entry: null,
    };
    const op = this.entriesOp;
    op.win.read(op.pos, Math.min(this.chunkSize, this.fileSize - op.pos), this.readEntriesCallback);
  }

  private readEntriesCallback: FsReadCallback = (err, bytesRead) => {
    const op = this.entriesOp;
    if (!op) {
      return;
    }
    if (err || !bytesRead) {
      this.emit('error', err ?? new Error('Entries read error'));
      return;
    }
    let bufferPos = op.pos - op.win.position;
    let entry = op.entry;
    const buffer = op.win.buffer;
    const bufferLength = buffer.length;
    try {
      while (op.entriesLeft > 0) {
        if (!entry) {
          entry = new ZipEntry();
          entry.readHeader(buffer, bufferPos);
          entry.headerOffset = op.win.position + bufferPos;
          op.entry = entry;
          op.pos += ZIP.CENHDR;
          bufferPos += ZIP.CENHDR;
        }
        const entryHeaderSize = entry.fnameLen + entry.extraLen + entry.comLen;
        const advanceBytes = entryHeaderSize + (op.entriesLeft > 1 ? ZIP.CENHDR : 0);
        if (bufferLength - bufferPos < advanceBytes) {
          op.win.moveRight(this.chunkSize, this.readEntriesCallback, bufferPos);
          op.move = true;
          return;
        }
        entry.read(buffer, bufferPos, this.textDecoder);
        if (!this.config.skipEntryNameValidation) {
          entry.validateName();
        }
        if (this.entryMap) {
          this.entryMap[entry.name] = entry;
        }
        this.emit('entry', entry);
        op.entry = null;
        entry = null;
        op.entriesLeft--;
        op.pos += entryHeaderSize;
        bufferPos += entryHeaderSize;
      }
      this.emit('ready');
    } catch (readErr) {
      this.emit('error', readErr);
    }
  };

  private dataOffset(entry: ZipEntry): number {
    return entry.offset + ZIP.LOCHDR + entry.fnameLen + entry.extraLen;
  }

  private canVerifyCrc(entry: ZipEntry): boolean {
    return (entry.flags & 0x8) !== 0x8;
  }
}

function parseZipTime(timebytes: number, datebytes: number): number {
  const timebits = toBits(timebytes, 16);
  const datebits = toBits(datebytes, 16);
  const mt = {
    h: Number.parseInt(timebits.slice(0, 5).join(''), 2),
    m: Number.parseInt(timebits.slice(5, 11).join(''), 2),
    s: Number.parseInt(timebits.slice(11, 16).join(''), 2) * 2,
    Y: Number.parseInt(datebits.slice(0, 7).join(''), 2) + 1980,
    M: Number.parseInt(datebits.slice(7, 11).join(''), 2),
    D: Number.parseInt(datebits.slice(11, 16).join(''), 2),
  };
  const dtStr = `${[mt.Y, mt.M, mt.D].join('-')} ${[mt.h, mt.m, mt.s].join(':')} GMT+0`;
  return new Date(dtStr).getTime();
}

function toBits(dec: number, size: number): string[] {
  let b = (dec >>> 0).toString(2);
  while (b.length < size) {
    b = `0${b}`;
  }
  return b.split('');
}

function readUInt64LE(buffer: Buffer, offset: number): number {
  return buffer.readUInt32LE(offset + 4) * 0x0000000100000000 + buffer.readUInt32LE(offset);
}
