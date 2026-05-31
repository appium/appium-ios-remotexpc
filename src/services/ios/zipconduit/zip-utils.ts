import type net from 'node:net';
import type { Readable } from 'node:stream';
import { Readable as ReadableStream } from 'node:stream';
import { crc32 } from 'node:zlib';

import { createPlist } from '../../../lib/plist/unified-plist-creator.js';
import type { PlistDictionary } from '../../../lib/types.js';
import { writeBufferToSocket } from '../afc/codec.js';
import {
  METAINF_FILE_NAME,
  ZIP_EXTRA_BYTES,
  ZIP_HEADER_LAST_MODIFIED_DATE,
  ZIP_HEADER_LAST_MODIFIED_TIME,
  ZIP_LOCAL_FILE_HEADER_SIGNATURE,
} from './constants.js';
import { createMetaInfPlist } from './plists.js';

interface ZipLocalHeader {
  signature: number;
  version: number;
  generalPurposeBitFlags: number;
  compressionMethod: number;
  lastModifiedTime: number;
  lastModifiedDate: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  fileNameLength: number;
  extraFieldLength: number;
}

/**
 * Encode ZipMetadata as XML plist bytes for META-INF/com.apple.ZipMetadata.plist.
 */
export function createMetaInfBytes(
  numFiles: number,
  totalBytes: number,
): Buffer {
  const metadata = createMetaInfPlist(
    numFiles,
    totalBytes,
  ) as unknown as PlistDictionary;
  const plist = createPlist(metadata, false);
  return Buffer.isBuffer(plist) ? plist : Buffer.from(plist, 'utf8');
}

/**
 * Write a streaming zip_conduit directory entry to the socket.
 */
export async function transferDirectory(
  socket: net.Socket,
  dstDirPath: string,
): Promise<void> {
  await writeBufferToSocket(socket, newZipHeaderDir(dstDirPath));
}

/**
 * Write a streaming zip_conduit file entry and its uncompressed payload.
 */
export async function transferFile(
  socket: net.Socket,
  src: Readable,
  crc32Value: number,
  uncompressedSize: number,
  dstFilePath: string,
): Promise<void> {
  await writeBufferToSocket(
    socket,
    newZipHeader(uncompressedSize, crc32Value, dstFilePath),
  );

  for await (const chunk of src) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    await writeBufferToSocket(socket, data);
  }
}

/**
 * Write the META-INF/ directory header expected by zip_conduit.
 */
export async function transferMetaInfDirectory(
  socket: net.Socket,
): Promise<void> {
  await transferDirectory(socket, 'META-INF/');
}

/**
 * Write the synthetic com.apple.ZipMetadata.plist entry.
 */
export async function transferMetaInfFile(
  socket: net.Socket,
  numFiles: number,
  totalBytes: number,
): Promise<void> {
  const metaInfBytes = createMetaInfBytes(numFiles, totalBytes);
  const checksum = crc32(metaInfBytes) >>> 0;
  await transferFile(
    socket,
    ReadableStream.from(metaInfBytes),
    checksum,
    metaInfBytes.length,
    `META-INF/${METAINF_FILE_NAME}`,
  );
}

function encodeZipLocalHeader(header: ZipLocalHeader): Buffer {
  const buf = Buffer.alloc(30);
  buf.writeUInt32LE(header.signature, 0);
  buf.writeUInt16LE(header.version, 4);
  buf.writeUInt16LE(header.generalPurposeBitFlags, 6);
  buf.writeUInt16LE(header.compressionMethod, 8);
  buf.writeUInt16LE(header.lastModifiedTime, 10);
  buf.writeUInt16LE(header.lastModifiedDate, 12);
  buf.writeUInt32LE(header.crc32 >>> 0, 14);
  buf.writeUInt32LE(header.compressedSize >>> 0, 18);
  buf.writeUInt32LE(header.uncompressedSize >>> 0, 22);
  buf.writeUInt16LE(header.fileNameLength, 26);
  buf.writeUInt16LE(header.extraFieldLength, 28);
  return buf;
}

function newZipHeaderDir(name: string): Buffer {
  const nameBytes = Buffer.from(name, 'utf8');
  const header = encodeZipLocalHeader({
    signature: ZIP_LOCAL_FILE_HEADER_SIGNATURE,
    version: 20,
    generalPurposeBitFlags: 0,
    compressionMethod: 0,
    lastModifiedTime: ZIP_HEADER_LAST_MODIFIED_TIME,
    lastModifiedDate: ZIP_HEADER_LAST_MODIFIED_DATE,
    crc32: 0,
    compressedSize: 0,
    uncompressedSize: 0,
    fileNameLength: nameBytes.length,
    extraFieldLength: ZIP_EXTRA_BYTES.length,
  });
  return Buffer.concat([header, nameBytes, ZIP_EXTRA_BYTES]);
}

function newZipHeader(size: number, crc32Value: number, name: string): Buffer {
  const nameBytes = Buffer.from(name, 'utf8');
  const header = encodeZipLocalHeader({
    signature: ZIP_LOCAL_FILE_HEADER_SIGNATURE,
    version: 20,
    generalPurposeBitFlags: 0,
    compressionMethod: 0,
    lastModifiedTime: ZIP_HEADER_LAST_MODIFIED_TIME,
    lastModifiedDate: ZIP_HEADER_LAST_MODIFIED_DATE,
    crc32: crc32Value >>> 0,
    compressedSize: size >>> 0,
    uncompressedSize: size >>> 0,
    fileNameLength: nameBytes.length,
    extraFieldLength: ZIP_EXTRA_BYTES.length,
  });
  return Buffer.concat([header, nameBytes, ZIP_EXTRA_BYTES]);
}
