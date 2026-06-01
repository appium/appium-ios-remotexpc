import type { Readable } from 'node:stream';

import StreamZipImpl from '../../../lib/zip/stream-zip.cjs';
import { TRANSFER_CHUNK_SIZE } from './constants.js';

/** Subset of a ZIP central-directory entry used while streaming an IPA. */
export interface IpaZipEntry {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
  crc: number;
  size: number;
  method: number;
}

/** The reading surface of the stream-zip async archive that we depend on. */
interface ZipArchive {
  entries(): Promise<Record<string, IpaZipEntry>>;
  stream(entry: IpaZipEntry | string): Promise<Readable>;
  close(): Promise<void>;
}

interface StreamZipOptions {
  file: string;
  chunkSize?: number;
}

const StreamZip = StreamZipImpl as unknown as {
  async: new (options: StreamZipOptions) => ZipArchive;
};

/**
 * Open an IPA archive, run `fn`, and close the handle when done.
 */
export async function withZipFile<T>(
  ipaPath: string,
  fn: (zip: ZipArchive) => Promise<T>,
): Promise<T> {
  const zip = new StreamZip.async({
    file: ipaPath,
    chunkSize: TRANSFER_CHUNK_SIZE,
  });
  try {
    return await fn(zip);
  } finally {
    await zip.close();
  }
}

/** List all entries from an already-open IPA archive without extracting them. */
export async function listZipEntries(zip: ZipArchive): Promise<IpaZipEntry[]> {
  const entries = await zip.entries();
  return Object.values(entries);
}

/** Open a decompressed readable stream for one zip entry. */
export async function openZipEntryStream(
  zip: ZipArchive,
  entry: IpaZipEntry,
): Promise<Readable> {
  return await zip.stream(entry);
}
