import type { Readable } from 'node:stream';

import { TRANSFER_CHUNK_SIZE } from './constants.js';
import { StreamZip, type StreamZipEntry } from './stream-zip.js';

/** Subset of a ZIP central-directory entry used while streaming an IPA. */
export type IpaZipEntry = StreamZipEntry;

/** Reading surface of an open ZIP archive used by ZipConduit. */
export type ZipArchive = Pick<StreamZip, 'entries' | 'stream' | 'close'>;

/**
 * Open an IPA archive, run `fn`, and close the handle when done.
 */
export async function withZipFile<T>(
  ipaPath: string,
  fn: (zip: ZipArchive) => Promise<T>,
): Promise<T> {
  const zip = new StreamZip({
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
