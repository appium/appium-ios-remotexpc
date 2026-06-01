import { createReadStream } from 'node:fs';
import { type FileHandle, open } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { createInflateRaw } from 'node:zlib';

/**
 * Minimal streaming ZIP reader.
 *
 * Implements just enough of the ZIP format (PKWARE APPNOTE) to list the
 * central directory and stream a single entry's decompressed contents — the
 * only operations ZipConduit needs to forward an IPA to the device.
 *
 * Supported: STORED (0) and DEFLATE (8) entries on a single-disk archive.
 * Not supported: ZIP64, encryption, multi-disk archives (clear errors thrown).
 */

const SIGNATURE_END_OF_CENTRAL_DIR = 0x06054b50;
const SIGNATURE_CENTRAL_FILE_HEADER = 0x02014b50;
const SIGNATURE_LOCAL_FILE_HEADER = 0x04034b50;

const END_OF_CENTRAL_DIR_SIZE = 22;
const CENTRAL_FILE_HEADER_SIZE = 46;
const LOCAL_FILE_HEADER_SIZE = 30;
const MAX_COMMENT_SIZE = 0xffff;

const ZIP64_MARKER_16 = 0xffff;
const ZIP64_MARKER_32 = 0xffffffff;

const COMPRESSION_STORED = 0;
const COMPRESSION_DEFLATE = 8;

export interface ZipEntry {
  /** Entry path within the archive. */
  name: string;
  /** True when the entry is a directory (name ends with '/'). */
  isDirectory: boolean;
  /** True when the entry is a file. */
  isFile: boolean;
  /** CRC-32 of the uncompressed data, as recorded in the central directory. */
  crc: number;
  /** Uncompressed size in bytes. */
  size: number;
  /** Compressed size in bytes. */
  compressedSize: number;
  /** Compression method (0 = stored, 8 = deflate). */
  method: number;
  /** Offset of this entry's local file header from the start of the archive. */
  offset: number;
}

export interface ZipOpenOptions {
  /** Buffer size used while streaming an entry's payload from disk. */
  highWaterMark?: number;
}

interface EndOfCentralDirectory {
  entryCount: number;
  size: number;
  offset: number;
}

/** A read-only handle over a ZIP archive on disk. */
export class ZipArchive {
  private constructor(
    private readonly handle: FileHandle,
    private readonly filePath: string,
    private readonly entriesByName: Record<string, ZipEntry>,
    private readonly highWaterMark?: number,
  ) {}

  /** Open an archive and parse its central directory. */
  static async open(
    filePath: string,
    options: ZipOpenOptions = {},
  ): Promise<ZipArchive> {
    const handle = await open(filePath, 'r');
    try {
      const { size } = await handle.stat();
      const entries = await readCentralDirectory(handle, size);
      return new ZipArchive(handle, filePath, entries, options.highWaterMark);
    } catch (err) {
      await handle.close();
      throw err;
    }
  }

  /** All entries, keyed by name. */
  entries(): Record<string, ZipEntry> {
    return this.entriesByName;
  }

  /**
   * Open a readable stream of an entry's decompressed contents.
   * The returned stream owns its own file descriptor; destroying it frees it.
   */
  async openReadStream(entry: ZipEntry): Promise<Readable> {
    if (entry.isDirectory) {
      throw new Error(`Cannot stream a directory entry: ${entry.name}`);
    }
    if (entry.compressedSize === 0) {
      return Readable.from([]);
    }

    const dataOffset = await this.resolveDataOffset(entry);
    const raw = createReadStream(this.filePath, {
      start: dataOffset,
      end: dataOffset + entry.compressedSize - 1,
      highWaterMark: this.highWaterMark,
    });

    if (entry.method === COMPRESSION_STORED) {
      return raw;
    }
    if (entry.method === COMPRESSION_DEFLATE) {
      const inflate = createInflateRaw();
      raw.once('error', (err) => inflate.destroy(err));
      inflate.once('close', () => raw.destroy());
      raw.pipe(inflate);
      return inflate;
    }

    raw.destroy();
    throw new Error(
      `Unsupported compression method ${entry.method} for ${entry.name}`,
    );
  }

  /** Close the archive's underlying file handle. */
  async close(): Promise<void> {
    await this.handle.close();
  }

  /**
   * The payload offset can only be derived from the local file header, whose
   * extra-field length may differ from the central directory record.
   */
  private async resolveDataOffset(entry: ZipEntry): Promise<number> {
    const header = Buffer.allocUnsafe(LOCAL_FILE_HEADER_SIZE);
    const { bytesRead } = await this.handle.read(
      header,
      0,
      LOCAL_FILE_HEADER_SIZE,
      entry.offset,
    );
    if (
      bytesRead !== LOCAL_FILE_HEADER_SIZE ||
      header.readUInt32LE(0) !== SIGNATURE_LOCAL_FILE_HEADER
    ) {
      throw new Error(`Invalid local file header for ${entry.name}`);
    }
    const nameLength = header.readUInt16LE(26);
    const extraLength = header.readUInt16LE(28);
    return entry.offset + LOCAL_FILE_HEADER_SIZE + nameLength + extraLength;
  }
}

async function readCentralDirectory(
  handle: FileHandle,
  fileSize: number,
): Promise<Record<string, ZipEntry>> {
  const eocd = await readEndOfCentralDirectory(handle, fileSize);
  const buffer = Buffer.allocUnsafe(eocd.size);
  const { bytesRead } = await handle.read(buffer, 0, eocd.size, eocd.offset);
  if (bytesRead !== eocd.size) {
    throw new Error('Truncated central directory');
  }

  const entries: Record<string, ZipEntry> = {};
  let pos = 0;
  for (let i = 0; i < eocd.entryCount; i++) {
    if (
      pos + CENTRAL_FILE_HEADER_SIZE > buffer.length ||
      buffer.readUInt32LE(pos) !== SIGNATURE_CENTRAL_FILE_HEADER
    ) {
      throw new Error('Invalid central directory entry');
    }

    const method = buffer.readUInt16LE(pos + 10);
    const crc = buffer.readUInt32LE(pos + 16);
    const compressedSize = buffer.readUInt32LE(pos + 20);
    const size = buffer.readUInt32LE(pos + 24);
    const nameLength = buffer.readUInt16LE(pos + 28);
    const extraLength = buffer.readUInt16LE(pos + 30);
    const commentLength = buffer.readUInt16LE(pos + 32);
    const offset = buffer.readUInt32LE(pos + 42);

    if (
      size === ZIP64_MARKER_32 ||
      compressedSize === ZIP64_MARKER_32 ||
      offset === ZIP64_MARKER_32
    ) {
      throw new Error('ZIP64 archives are not supported');
    }

    const nameStart = pos + CENTRAL_FILE_HEADER_SIZE;
    const name = buffer.toString('utf8', nameStart, nameStart + nameLength);
    const isDirectory = name.endsWith('/');
    entries[name] = {
      name,
      isDirectory,
      isFile: !isDirectory,
      crc: crc >>> 0,
      size,
      compressedSize,
      method,
      offset,
    };
    pos = nameStart + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function readEndOfCentralDirectory(
  handle: FileHandle,
  fileSize: number,
): Promise<EndOfCentralDirectory> {
  const readLength = Math.min(
    fileSize,
    END_OF_CENTRAL_DIR_SIZE + MAX_COMMENT_SIZE,
  );
  const buffer = Buffer.allocUnsafe(readLength);
  const { bytesRead } = await handle.read(
    buffer,
    0,
    readLength,
    fileSize - readLength,
  );

  // Scan backwards for the signature; the real record is the one whose comment
  // length lands exactly at end-of-file (disambiguates signatures in comments).
  for (let i = bytesRead - END_OF_CENTRAL_DIR_SIZE; i >= 0; i--) {
    if (buffer.readUInt32LE(i) !== SIGNATURE_END_OF_CENTRAL_DIR) {
      continue;
    }
    const commentLength = buffer.readUInt16LE(i + 20);
    if (i + END_OF_CENTRAL_DIR_SIZE + commentLength !== bytesRead) {
      continue;
    }

    const entryCount = buffer.readUInt16LE(i + 10);
    const size = buffer.readUInt32LE(i + 12);
    const offset = buffer.readUInt32LE(i + 16);
    if (
      entryCount === ZIP64_MARKER_16 ||
      size === ZIP64_MARKER_32 ||
      offset === ZIP64_MARKER_32
    ) {
      throw new Error('ZIP64 archives are not supported');
    }
    return { entryCount, size, offset };
  }
  throw new Error(
    'End of central directory record not found (not a ZIP file?)',
  );
}
